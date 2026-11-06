// path: lib/kyc/adapters/supplementary-idv-settings.ts

import { hasSatisfiedTwoFactor, requireAnyRole } from "../../auth/session.ts";
import type { PlatformRole, RequestActor } from "../../auth/types.ts";
import { AppError } from "../../errors/app-error.ts";
import { deepFreeze } from "../../utils/freeze.ts";
import {
  PROCESSOR_KYB_AUTHORITY,
  SUPPLEMENTARY_IDV_CONFIG_STATUSES,
  SUPPLEMENTARY_IDV_ENVIRONMENTS,
  SUPPLEMENTARY_IDV_MAXIMUM_ACTIVE_VENDORS,
  SUPPLEMENTARY_IDV_VENDOR_KEYS,
  isSupplementaryIdvVendorKey,
  recordSupplementaryIdvProcessorWriteRefusal,
  refuseProcessorKybWrite,
  supplementaryIdvEvidenceOf,
  supplementaryIdvMerchantStatusOf,
  supplementaryIdvModeOf,
  supplementaryIdvVendorOf,
  type KycVerificationMode,
  type ProcessorKybStatus,
  type SupplementaryIdvAuditEntry,
  type SupplementaryIdvConfig,
  type SupplementaryIdvConfigStatus,
  type SupplementaryIdvConfigStore,
  type SupplementaryIdvEnvironment,
  type SupplementaryIdvEvidence,
  type SupplementaryIdvMerchantStatus,
  type SupplementaryIdvResult,
  type SupplementaryIdvSession,
  type SupplementaryIdvSessionStore,
  type SupplementaryIdvVendorKey,
} from "./supplementary-idv.ts";

/**
 * Who switches the supplementary identity vendor on, what the office reads afterwards, and the gate that keeps the
 * processor the only authority on KYB.
 *
 * ## The three rules this file exists to hold
 *
 * FEATURE_LIST section 5 states them in one paragraph: "KYC runs in Manual mode while none of Jumio, Didit or Sumsub
 * is connected", "super_admin selects one active KYC provider in settings", and "when none is active, Manual KYC
 * runs". STEP 170 already decided what a set of configurations *means* (`supplementaryIdvModeOf`: none active is
 * manual, exactly one is automatic with that vendor, more than one is manual with the defect named in the reason).
 * This file is the only place those configurations are **changed** and the only place the office reads them, so the
 * rule "at most one active" is enforced where a second one could appear:
 *
 *   1. **One active vendor.** Selecting a vendor retires every other active configuration of the same company and the
 *      same environment first, in the same call. There is no input that leaves two active rows behind, and a
 *      retirement that loses its version race stops the selection and leaves the company in manual mode rather than
 *      in a state where two vendors could both run.
 *   2. **Manual is a real mode, not an absence.** Choosing manual retires the active row deliberately, and a company
 *      with no active row is a company in manual mode. The merchant is told "verification is in progress" either way,
 *      because FEATURE_LIST section 5 forbids telling the merchant which method was used.
 *   3. **The processor stays the authority.** `supplementaryIdvProcessorGateOf` hands a reviewer evidence with
 *      `changesProcessorKyb: false`; `attemptSupplementaryIdvProcessorWrite` refuses every write, whatever the
 *      candidate and whoever the caller is, and records the refusal through STEP 170's audited helper. A Jumio pass
 *      is not a `verified`; only the processor's own verdict is.
 *
 * ## What this file deliberately does not do
 *
 * It writes no configuration's credentials. A selection changes `status`, `version` and `updatedAtEpochMs` and
 * nothing else: every write is a spread of the row the store returned, so the sealed credential and the sealed
 * delivery secret are carried across byte for byte. STEP 170's store backs that up where it can (it refuses a save
 * that moves the company, the vendor, the environment or `credentialSealed`, a save at the wrong version, and any
 * write to a retired row), and the gate asserts the stronger property on this file's own output: after a selection the
 * two sealed columns are identical strings. The sealed secrets are STEP 170's and the keyring is STEP 056's; this file
 * never opens either.
 *
 * It calls no vendor. Turning "the selected vendor" into a session is STEP 170's port and its 171-173 adapters, and
 * turning a delivery into an answer is STEP 174's receiver. This file only decides *whether* an automatic check may
 * run and *what the office does* with what came back.
 *
 * It owns no route and no screen component: `app/` belongs to a later STEP, exactly as STEPs 170-174 recorded. The
 * service below is what such a route calls, and `canWriteSupplementaryIdvSettings` is what it asks before rendering
 * the control, so the permission is decided once, in the library, and not in a component.
 *
 * It rewrites no session. A stalled session is *reported* (`stalledSessionIds`), never rewritten into `expired`: the
 * only way STEP 170 lets a session move is `recordSupplementaryIdvAnswer`, which needs the vendor's own reference,
 * and a row that never reached the vendor has none. Inventing a reference to force an expiry would put a value in
 * the table that no vendor ever issued, so a stall stays visible to the office instead.
 */

/* -------------------------------------------------------------------------------------------------
 * Who may change the selection
 * ---------------------------------------------------------------------------------------------- */

/**
 * The role that selects the vendor: FEATURE_LIST section 5 says super_admin, and says nothing about anyone else, so
 * compliance and the CEO read the settings but do not switch the vendor.
 */
export const SUPPLEMENTARY_IDV_SETTINGS_ROLES: readonly PlatformRole[] = deepFreeze(["super_admin"] as const);

/**
 * The second factor is required on top of the role.
 *
 * Switching the vendor decides which company's identity documents are sent to which processor's competitor, so a
 * stolen `aal1` session is not enough. `hasSatisfiedTwoFactor` is the platform's own answer to "did this session
 * present a second factor, and is it allowed to act", which is why the check is not written out again here.
 */
export function requireSupplementaryIdvSettingsActor(actor: RequestActor): RequestActor {
  requireAnyRole(actor, SUPPLEMENTARY_IDV_SETTINGS_ROLES);
  if (!hasSatisfiedTwoFactor(actor)) {
    // There is no step-up error code in the catalogue; PERMISSION_DENIED is the code the session guards use, and a
    // caller that is allowed the role but has not presented the second factor is denied, not unauthenticated.
    throw new AppError("PERMISSION_DENIED", {
      details: [{ field: "actor.twoFactorSatisfied", rule: "selecting a supplementary identity vendor requires a second factor" }],
    });
  }
  return actor;
}

/** The same answer without throwing, for a screen that renders the control disabled instead of failing a request. */
export function canWriteSupplementaryIdvSettings(actor: RequestActor): boolean {
  const hasRole = SUPPLEMENTARY_IDV_SETTINGS_ROLES.some((role) => actor.roles.includes(role));
  return hasRole && hasSatisfiedTwoFactor(actor);
}

/* -------------------------------------------------------------------------------------------------
 * Input, validated once
 * ---------------------------------------------------------------------------------------------- */

function requireSettingText(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field, rule: "this value is required" }] });
  }
  return trimmed;
}

function requireEnvironment(value: SupplementaryIdvEnvironment): SupplementaryIdvEnvironment {
  if ((SUPPLEMENTARY_IDV_ENVIRONMENTS as readonly string[]).includes(value) === false) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "environment", rule: `must be one of ${SUPPLEMENTARY_IDV_ENVIRONMENTS.join(", ")}` }],
    });
  }
  return value;
}

function requireVendor(value: SupplementaryIdvVendorKey): SupplementaryIdvVendorKey {
  if (isSupplementaryIdvVendorKey(value) === false) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "vendorKey", rule: `must be one of ${SUPPLEMENTARY_IDV_VENDOR_KEYS.join(", ")}` }],
    });
  }
  return value;
}

function isConfigStatus(value: string): value is SupplementaryIdvConfigStatus {
  return (SUPPLEMENTARY_IDV_CONFIG_STATUSES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------------------------------
 * The settings view: what the office screen reads
 * ---------------------------------------------------------------------------------------------- */

/** One vendor of the catalogue as the settings screen shows it, configured or not. */
export interface SupplementaryIdvVendorSetting {
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly configured: boolean;
  readonly configId: string | null;
  readonly status: SupplementaryIdvConfigStatus | "not_configured";
  readonly environment: SupplementaryIdvEnvironment;
  /** True only for an active row: active means the vendor's own activation test proved the credentials. */
  readonly activationProven: boolean;
  readonly active: boolean;
}

/** One company's supplementary settings in one environment. */
export interface SupplementaryIdvSettingsView {
  readonly companyId: string;
  readonly environment: SupplementaryIdvEnvironment;
  readonly mode: KycVerificationMode;
  readonly activeVendorKey: SupplementaryIdvVendorKey | null;
  /** STEP 170's reason, carried unchanged so the office reads the one sentence that explains the mode. */
  readonly reason: string;
  readonly activeCount: number;
  /** True when more than one row is active: a defect the office must see, never repaired by picking one at random. */
  readonly defect: boolean;
  readonly vendors: readonly SupplementaryIdvVendorSetting[];
}

export interface SupplementaryIdvSettingsInput {
  readonly companyId: string;
  readonly environment: SupplementaryIdvEnvironment;
  readonly configs: readonly SupplementaryIdvConfig[];
}

function vendorSettingOf(
  vendorKey: SupplementaryIdvVendorKey,
  scoped: readonly SupplementaryIdvConfig[],
  environment: SupplementaryIdvEnvironment,
): SupplementaryIdvVendorSetting {
  const rows = scoped.filter((config) => config.vendorKey === vendorKey);
  const first = rows[0];
  if (first === undefined) {
    return {
      vendorKey,
      configured: false,
      configId: null,
      status: "not_configured",
      environment,
      activationProven: false,
      active: false,
    };
  }
  const active = rows.find((config) => config.status === "active");
  const chosen =
    active ??
    rows.reduce((newest, config) => (config.updatedAtEpochMs >= newest.updatedAtEpochMs ? config : newest), first);
  const status: SupplementaryIdvConfigStatus | "not_configured" = isConfigStatus(chosen.status) ? chosen.status : "not_configured";
  return {
    vendorKey,
    configured: true,
    configId: chosen.id,
    status,
    environment,
    activationProven: status === "active",
    active: status === "active",
  };
}

/**
 * The settings view for one company and one environment.
 *
 * The mode is computed per environment: a live selection must not make the sandbox run automatically, and the
 * reverse is true too. Only rows of the named company are read, so a configuration of another company can never
 * appear as a candidate.
 */
export function supplementaryIdvSettingsOf(input: SupplementaryIdvSettingsInput): SupplementaryIdvSettingsView {
  const companyId = requireSettingText(input.companyId, "companyId");
  const environment = requireEnvironment(input.environment);
  const scoped = input.configs.filter((config) => config.companyId === companyId && config.environment === environment);
  const mode = supplementaryIdvModeOf(scoped);
  const activeCount = scoped.filter((config) => config.status === "active").length;
  return {
    companyId,
    environment,
    mode: mode.mode,
    activeVendorKey: mode.vendorKey,
    reason: mode.reason,
    activeCount,
    defect: activeCount > SUPPLEMENTARY_IDV_MAXIMUM_ACTIVE_VENDORS,
    vendors: SUPPLEMENTARY_IDV_VENDOR_KEYS.map((key) => vendorSettingOf(key, scoped, environment)),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Audit
 * ---------------------------------------------------------------------------------------------- */

/**
 * One audit entry a selection hands to the caller's audit writer.
 *
 * FEATURE_LIST section 5 ends with "Every KYC decision is audit logged", and switching the vendor is such a decision.
 * The entry names the actor, carries no personal data and no credential, and is office-only: the merchant is never
 * told which vendor ran or that one was switched.
 */
export interface SupplementaryIdvSettingsAuditEntry {
  readonly action:
    | "supplementary_idv.vendor_selected"
    | "supplementary_idv.vendor_retired"
    | "supplementary_idv.manual_selected"
    | "supplementary_idv.selection_refused";
  readonly companyId: string;
  readonly environment: SupplementaryIdvEnvironment;
  readonly vendorKey: SupplementaryIdvVendorKey | null;
  readonly configId: string | null;
  readonly retiredConfigIds: readonly string[];
  readonly actorUserId: string;
  readonly reason: string | null;
  /** Always true: the vendor's identity and the reason for switching it are office information. */
  readonly officeOnly: true;
  readonly occurredAtEpochMs: number;
}

/** What every function below needs. */
export interface SupplementaryIdvSettingsOptions {
  readonly configStore: SupplementaryIdvConfigStore;
  readonly recordAudit?: (entry: SupplementaryIdvSettingsAuditEntry) => void;
}

/* -------------------------------------------------------------------------------------------------
 * Selecting one vendor, which retires the others
 * ---------------------------------------------------------------------------------------------- */

/** The outcomes a selection can have. */
export const SUPPLEMENTARY_IDV_SELECTION_STATUSES = deepFreeze(["selected", "unchanged", "refused", "failed"] as const);

export interface SelectSupplementaryIdvVendorInput {
  readonly actor: RequestActor;
  readonly companyId: string;
  readonly environment: SupplementaryIdvEnvironment;
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly configId: string;
  readonly occurredAtEpochMs: number;
}

export type SelectSupplementaryIdvVendorResult =
  | { readonly status: "selected"; readonly view: SupplementaryIdvSettingsView; readonly retiredConfigIds: readonly string[] }
  | { readonly status: "unchanged"; readonly view: SupplementaryIdvSettingsView }
  | { readonly status: "refused"; readonly reason: string; readonly view: SupplementaryIdvSettingsView }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly view: SupplementaryIdvSettingsView;
      readonly retiredConfigIds: readonly string[];
    };

/**
 * Select one vendor as the company's only active supplementary identity vendor.
 *
 * The order is the security property:
 *
 *   1. the actor must hold the role *and* have presented a second factor, checked before any row is read, so a denied
 *      caller learns nothing about the configurations;
 *   2. the configuration is resolved from the four things the caller names (company, environment, vendor, id) and any
 *      disagreement is a refusal, so a body cannot point at another company's row;
 *   3. the chosen row must already be `active`. A `pending_activation` row has credentials no activation test has
 *      proved, and a retired row is history: neither can be switched on by a selection;
 *   4. every other active row of the same company and environment is retired first, so at no point are two rows
 *      active. Each retirement is its own version-guarded write and its own audit entry;
 *   5. only then is the selection audited, with the ids that were retired, so the trail explains the single active row.
 *
 * An already-correct selection writes nothing and audits nothing: a repeated click is not a decision. A retirement
 * that loses a version race returns `failed` and leaves the company in manual mode, which is the safe direction.
 */
export function selectSupplementaryIdvVendor(
  input: SelectSupplementaryIdvVendorInput,
  options: SupplementaryIdvSettingsOptions,
): SelectSupplementaryIdvVendorResult {
  const actor = requireSupplementaryIdvSettingsActor(input.actor);
  const companyId = requireSettingText(input.companyId, "companyId");
  const environment = requireEnvironment(input.environment);
  const vendorKey = requireVendor(input.vendorKey);
  const configId = requireSettingText(input.configId, "configId");
  const occurredAtEpochMs = input.occurredAtEpochMs;

  const viewNow = (): SupplementaryIdvSettingsView =>
    supplementaryIdvSettingsOf({ companyId, environment, configs: options.configStore.listForCompany(companyId) });

  const refuse = (reason: string): SelectSupplementaryIdvVendorResult => {
    options.recordAudit?.({
      action: "supplementary_idv.selection_refused",
      companyId,
      environment,
      vendorKey,
      configId,
      retiredConfigIds: [],
      actorUserId: actor.userId,
      reason,
      officeOnly: true,
      occurredAtEpochMs,
    });
    return { status: "refused", reason, view: viewNow() };
  };

  const config = options.configStore.findById(configId);
  if (config === null) return refuse("no configuration holds that id");
  if (config.companyId !== companyId) return refuse("that configuration belongs to another company");
  if (config.vendorKey !== vendorKey) return refuse(`that configuration is for ${config.vendorKey}, not ${vendorKey}`);
  if (config.environment !== environment) return refuse(`that configuration is for the ${config.environment} environment`);
  if (config.status === "retired") return refuse("a retired configuration cannot be selected again");
  if (config.status === "pending_activation") {
    return refuse("the credentials of this configuration have not passed an activation test");
  }

  const others = options.configStore
    .listForCompany(companyId)
    .filter((row) => row.environment === environment && row.status === "active" && row.id !== config.id);
  if (others.length === 0) return { status: "unchanged", view: viewNow() };

  const retiredConfigIds: string[] = [];
  for (const other of others) {
    // Only the status, the version and the timestamp change. The sealed credentials are carried across untouched,
    // and STEP 170's store refuses a save that would alter any of them.
    const next: SupplementaryIdvConfig = {
      ...other,
      status: "retired",
      version: other.version + 1,
      updatedAtEpochMs: occurredAtEpochMs,
    };
    if (options.configStore.save(next, other.version) === false) {
      const reason = `the configuration ${other.id} moved while it was being retired`;
      options.recordAudit?.({
        action: "supplementary_idv.selection_refused",
        companyId,
        environment,
        vendorKey,
        configId,
        retiredConfigIds: [...retiredConfigIds],
        actorUserId: actor.userId,
        reason,
        officeOnly: true,
        occurredAtEpochMs,
      });
      return { status: "failed", reason, view: viewNow(), retiredConfigIds: [...retiredConfigIds] };
    }
    retiredConfigIds.push(other.id);
    options.recordAudit?.({
      action: "supplementary_idv.vendor_retired",
      companyId,
      environment,
      vendorKey: other.vendorKey,
      configId: other.id,
      retiredConfigIds: [],
      actorUserId: actor.userId,
      reason: `retired so that ${vendorKey} is the only active vendor`,
      officeOnly: true,
      occurredAtEpochMs,
    });
  }

  options.recordAudit?.({
    action: "supplementary_idv.vendor_selected",
    companyId,
    environment,
    vendorKey,
    configId,
    retiredConfigIds: [...retiredConfigIds],
    actorUserId: actor.userId,
    reason: null,
    officeOnly: true,
    occurredAtEpochMs,
  });

  return { status: "selected", view: viewNow(), retiredConfigIds: [...retiredConfigIds] };
}

/* -------------------------------------------------------------------------------------------------
 * Choosing manual mode
 * ---------------------------------------------------------------------------------------------- */

export interface SelectManualSupplementaryIdvInput {
  readonly actor: RequestActor;
  readonly companyId: string;
  readonly environment: SupplementaryIdvEnvironment;
  readonly occurredAtEpochMs: number;
}

export type SelectManualSupplementaryIdvResult =
  | { readonly status: "selected"; readonly view: SupplementaryIdvSettingsView; readonly retiredConfigIds: readonly string[] }
  | { readonly status: "unchanged"; readonly view: SupplementaryIdvSettingsView }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly view: SupplementaryIdvSettingsView;
      readonly retiredConfigIds: readonly string[];
    };

/**
 * Put a company into manual mode on purpose by retiring every active row of the environment.
 *
 * Manual mode is not only "nobody configured a vendor": an office may switch automatic verification off, and that has
 * to be a recorded decision rather than a deletion. The rows are retired, never deleted, so the credentials and the
 * history stay and a later selection can activate the same row again after a fresh activation test.
 */
export function selectManualSupplementaryIdv(
  input: SelectManualSupplementaryIdvInput,
  options: SupplementaryIdvSettingsOptions,
): SelectManualSupplementaryIdvResult {
  const actor = requireSupplementaryIdvSettingsActor(input.actor);
  const companyId = requireSettingText(input.companyId, "companyId");
  const environment = requireEnvironment(input.environment);
  const occurredAtEpochMs = input.occurredAtEpochMs;

  const viewNow = (): SupplementaryIdvSettingsView =>
    supplementaryIdvSettingsOf({ companyId, environment, configs: options.configStore.listForCompany(companyId) });

  const active = options.configStore
    .listForCompany(companyId)
    .filter((row) => row.environment === environment && row.status === "active");
  if (active.length === 0) return { status: "unchanged", view: viewNow() };

  const retiredConfigIds: string[] = [];
  for (const row of active) {
    const next: SupplementaryIdvConfig = {
      ...row,
      status: "retired",
      version: row.version + 1,
      updatedAtEpochMs: occurredAtEpochMs,
    };
    if (options.configStore.save(next, row.version) === false) {
      const reason = `the configuration ${row.id} moved while automatic verification was being switched off`;
      options.recordAudit?.({
        action: "supplementary_idv.selection_refused",
        companyId,
        environment,
        vendorKey: row.vendorKey,
        configId: row.id,
        retiredConfigIds: [...retiredConfigIds],
        actorUserId: actor.userId,
        reason,
        officeOnly: true,
        occurredAtEpochMs,
      });
      return { status: "failed", reason, view: viewNow(), retiredConfigIds: [...retiredConfigIds] };
    }
    retiredConfigIds.push(row.id);
    options.recordAudit?.({
      action: "supplementary_idv.vendor_retired",
      companyId,
      environment,
      vendorKey: row.vendorKey,
      configId: row.id,
      retiredConfigIds: [],
      actorUserId: actor.userId,
      reason: "retired so that the company runs in manual mode",
      officeOnly: true,
      occurredAtEpochMs,
    });
  }

  options.recordAudit?.({
    action: "supplementary_idv.manual_selected",
    companyId,
    environment,
    vendorKey: null,
    configId: null,
    retiredConfigIds: [...retiredConfigIds],
    actorUserId: actor.userId,
    reason: null,
    officeOnly: true,
    occurredAtEpochMs,
  });

  return { status: "selected", view: viewNow(), retiredConfigIds: [...retiredConfigIds] };
}

/* -------------------------------------------------------------------------------------------------
 * The manual fallback, in the words each audience gets
 * ---------------------------------------------------------------------------------------------- */

/** How long an unfinished session may sit before the office is told it is stalled. Three days, and a parameter. */
export const SUPPLEMENTARY_IDV_STALE_AFTER_MS = 72 * 60 * 60 * 1000;

/**
 * What the fallback says to the office and to the merchant.
 *
 * The merchant's sentence is the same in all three cases on purpose: FEATURE_LIST section 5 says the merchant "only
 * sees verification status", so the mode, the vendor and the defect never reach the merchant's screen. The office's
 * sentence names the vendor when one is running and names the defect when two are.
 */
export interface SupplementaryIdvManualFallback {
  readonly mode: KycVerificationMode;
  readonly vendorKey: SupplementaryIdvVendorKey | null;
  readonly defect: boolean;
  readonly officeNote: string;
  readonly merchantNote: string;
  readonly merchantVisibleVendor: false;
}

const MERCHANT_IN_PROGRESS_NOTE = "Your verification is in progress.";

export function supplementaryIdvManualFallbackOf(view: SupplementaryIdvSettingsView): SupplementaryIdvManualFallback {
  if (view.mode === "automatic" && view.activeVendorKey !== null) {
    const vendor = supplementaryIdvVendorOf(view.activeVendorKey);
    const label = vendor === null ? view.activeVendorKey : vendor.label;
    return {
      mode: "automatic",
      vendorKey: view.activeVendorKey,
      defect: view.defect,
      officeNote: `${label} runs the automatic check; an incomplete or unsuccessful result goes to manual review.`,
      merchantNote: MERCHANT_IN_PROGRESS_NOTE,
      merchantVisibleVendor: false,
    };
  }
  const officeNote = view.defect
    ? "Configuration defect: more than one supplementary identity vendor is active, so every case is reviewed manually until one is retired."
    : "No supplementary identity vendor is active, so every case is reviewed manually.";
  return {
    mode: "manual",
    vendorKey: null,
    defect: view.defect,
    officeNote,
    merchantNote: MERCHANT_IN_PROGRESS_NOTE,
    merchantVisibleVendor: false,
  };
}

/* -------------------------------------------------------------------------------------------------
 * What the office works from
 * ---------------------------------------------------------------------------------------------- */

/** One session in the office's review queue. */
export interface SupplementaryIdvQueueItem {
  readonly sessionId: string;
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly result: SupplementaryIdvResult;
  readonly reasonCode: string | null;
  readonly requiresHumanReview: boolean;
  /** How long since the row last changed. */
  readonly ageMs: number;
  /** True for a session still in progress past the deadline: visible, and never rewritten into an expiry. */
  readonly stalled: boolean;
  readonly processorKybStatusSeen: ProcessorKybStatus | null;
  readonly merchantStatus: SupplementaryIdvMerchantStatus;
}

/** The office's view of one company's supplementary checks. */
export interface SupplementaryIdvOperationsView {
  readonly settings: SupplementaryIdvSettingsView;
  /** The processor's own status, shown so a reviewer can compare. This file can never change it. */
  readonly processorKybStatus: ProcessorKybStatus | null;
  readonly processorKybAuthority: typeof PROCESSOR_KYB_AUTHORITY;
  readonly manualQueue: readonly SupplementaryIdvQueueItem[];
  readonly stalledSessionIds: readonly string[];
  readonly staleAfterMs: number;
}

export interface SupplementaryIdvOperationsInput {
  readonly companyId: string;
  readonly environment: SupplementaryIdvEnvironment;
  readonly configs: readonly SupplementaryIdvConfig[];
  readonly sessions: readonly SupplementaryIdvSession[];
  readonly processorKybStatus: ProcessorKybStatus | null;
  readonly nowEpochMs: number;
  readonly staleAfterMs?: number;
}

/**
 * The queue is what a person still has to look at: every terminal session, because a supplementary pass is evidence
 * and not a verdict, plus any session that has been in progress past the deadline. A fresh in-progress session is
 * simply waiting and is not in the queue. Oldest first, so the person who has waited longest is served first.
 *
 * The processor's status is copied through as a label. Nothing in this file writes it, and the returned view carries
 * `processorKybAuthority: "processor"` so a screen cannot present it as the result of the supplementary check.
 */
export function supplementaryIdvOperationsOf(input: SupplementaryIdvOperationsInput): SupplementaryIdvOperationsView {
  const companyId = requireSettingText(input.companyId, "companyId");
  const environment = requireEnvironment(input.environment);
  const staleAfterMs = input.staleAfterMs ?? SUPPLEMENTARY_IDV_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "staleAfterMs", rule: "must be a positive whole number of milliseconds" }] });
  }
  if (!Number.isSafeInteger(input.nowEpochMs) || input.nowEpochMs <= 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "nowEpochMs", rule: "must be a whole number of milliseconds since the epoch" }] });
  }

  const scoped = input.sessions.filter(
    (session) => session.companyId === companyId && session.environment === environment,
  );
  const queue: SupplementaryIdvQueueItem[] = [];
  const stalledSessionIds: string[] = [];
  for (const session of scoped) {
    const ageMs = Math.max(0, input.nowEpochMs - session.updatedAtEpochMs);
    const stalled = session.result === "in_progress" && ageMs >= staleAfterMs;
    if (stalled) stalledSessionIds.push(session.id);
    if (session.result === "in_progress" && !stalled) continue;
    queue.push({
      sessionId: session.id,
      vendorKey: session.vendorKey,
      result: session.result,
      reasonCode: session.reasonCode,
      requiresHumanReview: session.requiresHumanReview,
      ageMs,
      stalled,
      processorKybStatusSeen: session.processorKybStatusSeen,
      merchantStatus: supplementaryIdvMerchantStatusOf(session.result),
    });
  }
  queue.sort((left, right) => right.ageMs - left.ageMs);

  return {
    settings: supplementaryIdvSettingsOf({ companyId, environment, configs: input.configs }),
    processorKybStatus: input.processorKybStatus,
    processorKybAuthority: PROCESSOR_KYB_AUTHORITY,
    manualQueue: queue,
    stalledSessionIds,
    staleAfterMs,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The processor gate
 * ---------------------------------------------------------------------------------------------- */

/** What a reviewer may do with a session now. */
export const SUPPLEMENTARY_IDV_GATE_STEPS = deepFreeze(["wait", "review_available", "manual_review"] as const);

export type SupplementaryIdvGateStep = (typeof SUPPLEMENTARY_IDV_GATE_STEPS)[number];

/** A session read as evidence plus the gate that says nobody may turn it into a processor status. */
export interface SupplementaryIdvProcessorGate {
  readonly sessionId: string;
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly result: SupplementaryIdvResult;
  readonly evidence: SupplementaryIdvEvidence;
  readonly processorKybAuthority: typeof PROCESSOR_KYB_AUTHORITY;
  readonly changesProcessorKyb: false;
  readonly requiresHumanDecision: true;
  readonly step: SupplementaryIdvGateStep;
  readonly officeMessage: string;
  readonly merchantStatus: SupplementaryIdvMerchantStatus;
}

/**
 * Read one session through the gate.
 *
 * `wait` while the vendor is still running, `review_available` when the check passed (evidence a reviewer may read),
 * `manual_review` for a failure, an expiry or an unreadable answer. None of the three is a KYB verdict, and each
 * office message says so, because the sentence a reviewer reads is the last place the distinction could be lost.
 */
export function supplementaryIdvProcessorGateOf(session: SupplementaryIdvSession): SupplementaryIdvProcessorGate {
  const evidence = supplementaryIdvEvidenceOf(session);
  const step: SupplementaryIdvGateStep =
    session.result === "in_progress" ? "wait" : session.result === "passed" ? "review_available" : "manual_review";
  const officeMessage =
    step === "wait"
      ? "The check is still running, so nothing is decided yet."
      : step === "review_available"
        ? "The check produced evidence a reviewer may read; the processor's own KYB status is unchanged."
        : "The check did not complete successfully, so the case is reviewed manually; the processor's own KYB status is unchanged.";
  return {
    sessionId: session.id,
    vendorKey: session.vendorKey,
    result: session.result,
    evidence,
    processorKybAuthority: PROCESSOR_KYB_AUTHORITY,
    changesProcessorKyb: false,
    requiresHumanDecision: true,
    step,
    officeMessage,
    merchantStatus: supplementaryIdvMerchantStatusOf(session.result),
  };
}

export interface SupplementaryIdvProcessorWriteAttempt {
  /** Present when a request is the source of the attempt. Never consulted: no role can grant this write. */
  readonly actor?: RequestActor;
  readonly sessionId: string;
  readonly candidate: string;
}

/** The answer to every attempt: refused, with the gate that explains why, or without a gate when no session exists. */
export interface SupplementaryIdvProcessorWriteResult {
  readonly status: "refused";
  readonly reason: string;
  readonly gate: SupplementaryIdvProcessorGate | null;
}

export interface SupplementaryIdvProcessorWriteOptions {
  readonly sessionStore: SupplementaryIdvSessionStore;
  readonly occurredAtEpochMs: number;
  readonly recordAudit?: (entry: SupplementaryIdvAuditEntry) => void;
}

/**
 * Every attempt by supplementary code to set or lift a processor KYB status ends here, refused.
 *
 * The refusal is not conditional on the candidate being one of the five processor words, or on the session's result,
 * or on the caller's roles: a supplementary check is evidence, so there is no input for which this function returns
 * anything but `refused`. The attempt is recorded through STEP 170's audited refusal helper, so a future caller that
 * tries to turn a pass into `verified` leaves a trail instead of a silent catch.
 */
export function attemptSupplementaryIdvProcessorWrite(
  input: SupplementaryIdvProcessorWriteAttempt,
  options: SupplementaryIdvProcessorWriteOptions,
): SupplementaryIdvProcessorWriteResult {
  const sessionId = requireSettingText(input.sessionId, "sessionId");
  const candidate = typeof input.candidate === "string" ? input.candidate : "";
  const session = options.sessionStore.findById(sessionId);
  if (session === null) {
    return { status: "refused", reason: refuseProcessorKybWrite(candidate).reason, gate: null };
  }
  const refusal = recordSupplementaryIdvProcessorWriteRefusal(sessionId, candidate, {
    sessionStore: options.sessionStore,
    occurredAtEpochMs: options.occurredAtEpochMs,
    ...(options.recordAudit === undefined ? {} : { recordAudit: options.recordAudit }),
    vendorKey: session.vendorKey,
    companyId: session.companyId,
  });
  return { status: "refused", reason: refusal.reason, gate: supplementaryIdvProcessorGateOf(session) };
}

/* -------------------------------------------------------------------------------------------------
 * What the merchant sees
 * ---------------------------------------------------------------------------------------------- */

/** One session as the merchant's own screen shows it: an id and one of three phrases. */
export interface SupplementaryIdvMerchantSessionView {
  readonly sessionId: string;
  readonly status: SupplementaryIdvMerchantStatus;
}

/**
 * The merchant's view of a company's sessions.
 *
 * STEP 170 owns the three phrases and the mapping; this function only projects it, and the shape is deliberate: an id
 * and a phrase, so a serialised view cannot carry a vendor, a reason or a document kind even by accident.
 */
export function supplementaryIdvMerchantViewOf(
  sessions: readonly SupplementaryIdvSession[],
): readonly SupplementaryIdvMerchantSessionView[] {
  return sessions.map((session) => ({
    sessionId: session.id,
    status: supplementaryIdvMerchantStatusOf(session.result),
  }));
}
