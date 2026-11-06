// path: lib/kyc/adapters/supplementary-idv-settings-verify.ts

/**
 * The gate for the supplementary identity settings, its manual fallback and the processor-KYB gate.
 *
 * Run directly, because STEP 170's ownership rule keeps `package.json` out of these STEPs' hands:
 *
 *   node lib/kyc/adapters/supplementary-idv-settings-verify.ts
 *
 * Twelve sections, the shape STEPs 170 to 174 established: the constants, the permission, the settings view, the
 * selection, manual mode, the fallback's two audiences, the office's queue, the gate itself, every refused processor
 * write, the merchant's three phrases, the store's silence about sessions, and the source.
 *
 * Nothing here reaches the network and nothing here opens a sealed credential: the configurations are sealed with a
 * fixture keyring through STEP 170's helper, which is the only path that produces them.
 */

import { readFileSync } from "node:fs";
import { AppError } from "../../errors/app-error.ts";
import { PLATFORM_ROLES } from "../../auth/types.ts";
import type { PlatformRole, RequestActor } from "../../auth/types.ts";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  InMemorySupplementaryIdvConfigStore,
  InMemorySupplementaryIdvSessionStore,
  PROCESSOR_KYB_STATUSES,
  SUPPLEMENTARY_IDV_MAXIMUM_ACTIVE_VENDORS,
  SUPPLEMENTARY_IDV_MERCHANT_STATUSES,
  SUPPLEMENTARY_IDV_RESULTS,
  SUPPLEMENTARY_IDV_VENDOR_KEYS,
  SUPPLEMENTARY_IDV_VENDORS,
  openSupplementaryIdvSession,
  recordSupplementaryIdvAnswer,
  sealSupplementaryIdvConfig,
} from "./supplementary-idv.ts";
import type {
  SupplementaryIdvAuditEntry,
  SupplementaryIdvConfig,
  SupplementaryIdvConfigStore,
  SupplementaryIdvDocumentKind,
  SupplementaryIdvEnvironment,
  SupplementaryIdvLiveness,
  SupplementaryIdvReasonCode,
  SupplementaryIdvResult,
  SupplementaryIdvSession,
  SupplementaryIdvSessionStore,
  SupplementaryIdvVendorKey,
} from "./supplementary-idv.ts";
import {
  SUPPLEMENTARY_IDV_GATE_STEPS,
  SUPPLEMENTARY_IDV_SELECTION_STATUSES,
  SUPPLEMENTARY_IDV_SETTINGS_ROLES,
  SUPPLEMENTARY_IDV_STALE_AFTER_MS,
  attemptSupplementaryIdvProcessorWrite,
  canWriteSupplementaryIdvSettings,
  requireSupplementaryIdvSettingsActor,
  selectManualSupplementaryIdv,
  selectSupplementaryIdvVendor,
  supplementaryIdvManualFallbackOf,
  supplementaryIdvMerchantViewOf,
  supplementaryIdvOperationsOf,
  supplementaryIdvProcessorGateOf,
  supplementaryIdvSettingsOf,
} from "./supplementary-idv-settings.ts";
import type {
  SelectManualSupplementaryIdvInput,
  SelectSupplementaryIdvVendorInput,
  SupplementaryIdvSettingsAuditEntry,
  SupplementaryIdvSettingsOptions,
  SupplementaryIdvSettingsView,
} from "./supplementary-idv-settings.ts";

/* ---- the checking harness, the same shape STEPs 170 to 174 used ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, name: string): void {
  checks += 1;
  if (condition !== true) failures.push(name);
}

function expectEqual(actual: unknown, expected: unknown, name: string): void {
  checks += 1;
  if (actual !== expected) failures.push(`${name} (read ${asText(actual)}, wanted ${asText(expected)})`);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The error code a call throws, or a word saying it did not throw. */
function errorCodeOf(action: () => void): string {
  try {
    action();
    return "no_error";
  } catch (error) {
    return error instanceof AppError ? error.code : "not_an_app_error";
  }
}

/** The first error detail field a call throws, or a word saying it did not throw. */
function errorFieldOf(action: () => void): string {
  try {
    action();
    return "no_error";
  } catch (error) {
    if (error instanceof AppError) return error.details[0]?.field ?? "no_detail";
    return "not_an_app_error";
  }
}

/* ---- fixtures ---- */

const NOW = 1_779_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const COMPANY = "company_kd_idv_settings_gate";
const OTHER_COMPANY = "company_kd_idv_settings_other";
const SUPER_ADMIN_ID = "user_super_admin_0001";

const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 5).toString("base64") } };

interface ConfigSpec {
  readonly id: string;
  readonly vendorKey: SupplementaryIdvVendorKey;
  readonly status?: "pending_activation" | "active" | "retired";
  readonly environment?: SupplementaryIdvEnvironment;
  readonly companyId?: string;
}

function sealedConfig(spec: ConfigSpec): SupplementaryIdvConfig {
  const companyId = spec.companyId ?? COMPANY;
  const environment = spec.environment ?? "live";
  const sealed = sealSupplementaryIdvConfig(
    {
      companyId,
      vendorKey: spec.vendorKey,
      environment,
      credential: `credential_${spec.id}_0123456789`,
      webhookSecret: `secret_${spec.id}_0123456789`,
    },
    keyring,
  );
  if ("reason" in sealed) throw new Error(`the fixture could not be sealed: ${sealed.reason}`);
  return {
    id: spec.id,
    companyId,
    vendorKey: spec.vendorKey,
    environment,
    status: "pending_activation",
    credentialSealed: sealed.credentialSealed,
    webhookSecretSealed: sealed.webhookSecretSealed,
    version: 1,
    createdAtEpochMs: NOW - 10 * HOUR_MS,
    updatedAtEpochMs: NOW - 10 * HOUR_MS,
  };
}

function storeOf(specs: readonly ConfigSpec[]): InMemorySupplementaryIdvConfigStore {
  const store = new InMemorySupplementaryIdvConfigStore();
  for (const spec of specs) {
    const config = sealedConfig(spec);
    store.insert(config);
    const wanted = spec.status ?? "pending_activation";
    if (wanted !== "pending_activation") {
      const moved = store.save({ ...config, status: wanted, version: 2, updatedAtEpochMs: NOW - 9 * HOUR_MS }, 1);
      if (moved === false) throw new Error(`the fixture configuration ${spec.id} could not be moved to ${wanted}`);
    }
  }
  return store;
}

/** A row as the store holds it, with its status already moved: what a view, a session and a test see. */
function configWith(spec: ConfigSpec): SupplementaryIdvConfig {
  return mustConfig(storeOf([spec]), spec.id);
}

function mustConfig(store: SupplementaryIdvConfigStore, id: string): SupplementaryIdvConfig {
  const config = store.findById(id);
  if (config === null) throw new Error(`the fixture lost the configuration ${id}`);
  return config;
}

function mustSession(store: SupplementaryIdvSessionStore, id: string): SupplementaryIdvSession {
  const session = store.findById(id);
  if (session === null) throw new Error(`the fixture lost the session ${id}`);
  return session;
}

/** One row per configuration, so a test can prove that nothing changed. */
function snapshotOf(store: SupplementaryIdvConfigStore, companyId: string): string {
  return store
    .listForCompany(companyId)
    .map((row) => `${row.id}:${row.status}:${row.version}`)
    .sort()
    .join("|");
}

interface AuditSink {
  readonly entries: SupplementaryIdvSettingsAuditEntry[];
  readonly record: (entry: SupplementaryIdvSettingsAuditEntry) => void;
}

function auditSink(): AuditSink {
  const entries: SupplementaryIdvSettingsAuditEntry[] = [];
  return {
    entries,
    record: (entry) => {
      entries.push(entry);
    },
  };
}

function settingsOptions(store: SupplementaryIdvConfigStore, sink?: AuditSink): SupplementaryIdvSettingsOptions {
  return sink === undefined ? { configStore: store } : { configStore: store, recordAudit: sink.record };
}

function actorOf(roles: readonly PlatformRole[], overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: SUPER_ADMIN_ID,
    companyId: COMPANY,
    roles,
    sessionId: "session_idv_settings_gate_0001",
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: NOW - 10 * 60 * 1000,
    expiresAtEpochMs: NOW + 60 * 60 * 1000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    deviceProofKeyId: "device_idv_settings_gate_0001",
    sessionFamilyId: "family_idv_settings_gate_0001",
    mfaVerifiedAtEpochMs: NOW - 10 * 60 * 1000,
    reauthenticatedAtEpochMs: NOW - 10 * 60 * 1000,
    ...overrides,
  };
}

const SUPER_ADMIN = actorOf(["super_admin"]);

function selectInput(overrides: Partial<SelectSupplementaryIdvVendorInput> = {}): SelectSupplementaryIdvVendorInput {
  return {
    actor: SUPER_ADMIN,
    companyId: COMPANY,
    environment: "live",
    vendorKey: "sumsub",
    configId: "cfg_sumsub_live",
    occurredAtEpochMs: NOW,
    ...overrides,
  };
}

function manualInput(overrides: Partial<SelectManualSupplementaryIdvInput> = {}): SelectManualSupplementaryIdvInput {
  return {
    actor: SUPER_ADMIN,
    companyId: COMPANY,
    environment: "live",
    occurredAtEpochMs: NOW,
    ...overrides,
  };
}

/** A store whose `listForCompany` hands back one row at an older version, which is how a lost race looks. */
function laggingStore(inner: SupplementaryIdvConfigStore, laggingId: string): SupplementaryIdvConfigStore {
  return {
    findById: (id) => inner.findById(id),
    findActiveForCompany: (companyId) => inner.findActiveForCompany(companyId),
    listForCompany: (companyId) =>
      inner.listForCompany(companyId).map((row) => (row.id === laggingId ? { ...row, version: row.version - 1 } : row)),
    insert: (config) => inner.insert(config),
    save: (next, expectedVersion) => inner.save(next, expectedVersion),
  };
}

function viewOf(configs: readonly SupplementaryIdvConfig[], environment: SupplementaryIdvEnvironment = "live"): SupplementaryIdvSettingsView {
  return supplementaryIdvSettingsOf({ companyId: COMPANY, environment, configs });
}

/* -- sessions -- */

function openSessionIn(
  store: InMemorySupplementaryIdvSessionStore,
  config: SupplementaryIdvConfig,
  openedAtEpochMs: number = NOW - HOUR_MS,
): SupplementaryIdvSession {
  const opened = openSupplementaryIdvSession(
    {
      companyId: config.companyId,
      vendorKey: config.vendorKey,
      environment: config.environment,
      configId: config.id,
      processorKybStatusSeen: "pending",
    },
    { sessionStore: store, occurredAtEpochMs: openedAtEpochMs },
  );
  if (opened.status !== "opened") throw new Error(`the session fixture could not be opened: ${opened.reason}`);
  return opened.session;
}

interface AnswerSpec {
  readonly reference: string;
  readonly result: SupplementaryIdvResult;
  readonly liveness?: SupplementaryIdvLiveness;
  readonly documentKind?: SupplementaryIdvDocumentKind;
  readonly reasonCode?: SupplementaryIdvReasonCode;
}

function answeredSessionIn(
  store: InMemorySupplementaryIdvSessionStore,
  config: SupplementaryIdvConfig,
  answer: AnswerSpec,
  atEpochMs: number = NOW,
): SupplementaryIdvSession {
  const opened = openSessionIn(store, config, atEpochMs - HOUR_MS);
  const recorded = recordSupplementaryIdvAnswer(
    opened.id,
    {
      reference: answer.reference,
      result: answer.result,
      liveness: answer.liveness ?? (answer.result === "passed" ? "passed" : "in_progress"),
      documentKind: answer.documentKind ?? "passport",
      reasonCode: answer.reasonCode ?? "not_stated",
    },
    { sessionStore: store, occurredAtEpochMs: atEpochMs },
  );
  if (recorded.status !== "recorded") throw new Error(`the session fixture could not record an answer: ${recorded.reason}`);
  return recorded.session;
}

/** A session whose vendor never answered at all: the row exists, the reference does not. */
function unreachableSessionIn(
  store: InMemorySupplementaryIdvSessionStore,
  config: SupplementaryIdvConfig,
  atEpochMs: number,
  id: string,
): SupplementaryIdvSession {
  const session: SupplementaryIdvSession = {
    id,
    companyId: config.companyId,
    vendorKey: config.vendorKey,
    environment: config.environment,
    configId: config.id,
    reference: null,
    result: "unknown",
    liveness: "unknown",
    documentKind: "not_stated",
    processorKybStatusSeen: "pending",
    fallback: null,
    reasonCode: "vendor_unreachable",
    requiresHumanReview: true,
    version: 1,
    createdAtEpochMs: atEpochMs,
    updatedAtEpochMs: atEpochMs,
  };
  store.insert(session);
  return session;
}

/* ---- section 1: the constants ---- */

function checkConstants(): void {
  expectEqual(SUPPLEMENTARY_IDV_SETTINGS_ROLES.length, 1, "exactly one role may select the vendor");
  expectEqual(SUPPLEMENTARY_IDV_SETTINGS_ROLES[0], "super_admin", "the one role is super_admin");
  expect(SUPPLEMENTARY_IDV_SETTINGS_ROLES.includes("ceo") === false, "the CEO does not select the vendor");
  expect(SUPPLEMENTARY_IDV_SETTINGS_ROLES.includes("compliance_kyc") === false, "compliance does not select the vendor");
  expect(SUPPLEMENTARY_IDV_SETTINGS_ROLES.includes("support") === false, "support does not select the vendor");
  expect(Object.isFrozen(SUPPLEMENTARY_IDV_SETTINGS_ROLES) === true, "the role list is frozen");
  expectEqual(SUPPLEMENTARY_IDV_STALE_AFTER_MS, 72 * HOUR_MS, "the default stall deadline is three days");
  expectEqual(SUPPLEMENTARY_IDV_SELECTION_STATUSES.join(","), "selected,unchanged,refused,failed", "the four selection outcomes");
  expectEqual(SUPPLEMENTARY_IDV_GATE_STEPS.join(","), "wait,review_available,manual_review", "the three gate steps");
  expectEqual(SUPPLEMENTARY_IDV_MAXIMUM_ACTIVE_VENDORS, 1, "STEP 170 still says one active vendor");
  expectEqual(SUPPLEMENTARY_IDV_VENDORS.length, 3, "the catalogue still holds three vendors");
}

/* ---- section 2: who may write ---- */

function checkPermission(): void {
  const store = storeOf([
    { id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" },
    { id: "cfg_didit_live", vendorKey: "didit", status: "active" },
  ]);
  const before = snapshotOf(store, COMPANY);

  // The role alone opens the door.
  expectEqual(requireSupplementaryIdvSettingsActor(SUPER_ADMIN).userId, SUPER_ADMIN_ID, "a super_admin with a second factor is the actor");
  expectEqual(canWriteSupplementaryIdvSettings(SUPER_ADMIN), true, "the screen is enabled for that actor");
  expectEqual(requireSupplementaryIdvSettingsActor(SUPER_ADMIN) === SUPER_ADMIN, true, "the guard hands back the actor it was given");

  // Every other role of the catalogue is denied, and a denial changes nothing.
  for (const role of PLATFORM_ROLES) {
    if (role === "super_admin") continue;
    const actor = actorOf([role]);
    const code = errorCodeOf(() => selectSupplementaryIdvVendor(selectInput({ actor }), settingsOptions(store)));
    expectEqual(code, "PERMISSION_DENIED", `${role} may not select a vendor`);
    expectEqual(canWriteSupplementaryIdvSettings(actor), false, `${role}'s screen is disabled`);
    expectEqual(snapshotOf(store, COMPANY), before, `${role}'s denial leaves every configuration alone`);
  }

  // No roles at all is denied too, and so is a role list that merely mentions the word.
  expectEqual(errorCodeOf(() => selectSupplementaryIdvVendor(selectInput({ actor: actorOf([]) }), settingsOptions(store))), "PERMISSION_DENIED", "an actor with no role is denied");
  expectEqual(errorCodeOf(() => selectSupplementaryIdvVendor(selectInput({ actor: actorOf(["owner"]) }), settingsOptions(store))), "PERMISSION_DENIED", "a merchant owner is denied");

  // The second factor is required on top of the role.
  const withoutSecondFactor = actorOf(["super_admin"], { twoFactorSatisfied: false, assuranceLevel: "aal1" });
  const code = errorCodeOf(() => selectSupplementaryIdvVendor(selectInput({ actor: withoutSecondFactor }), settingsOptions(store)));
  expectEqual(code, "PERMISSION_DENIED", "a super_admin who has not presented a second factor is denied");
  expectEqual(
    errorFieldOf(() => selectSupplementaryIdvVendor(selectInput({ actor: withoutSecondFactor }), settingsOptions(store))),
    "actor.twoFactorSatisfied",
    "the denial names the second factor",
  );
  expectEqual(canWriteSupplementaryIdvSettings(withoutSecondFactor), false, "the screen is disabled without a second factor");
  const mustEnrol = actorOf(["super_admin"], { twoFactorEnrolmentRequired: true });
  expectEqual(errorCodeOf(() => selectSupplementaryIdvVendor(selectInput({ actor: mustEnrol }), settingsOptions(store))), "PERMISSION_DENIED", "a super_admin who must enrol is denied");
  expectEqual(canWriteSupplementaryIdvSettings(mustEnrol), false, "the screen is disabled while enrolment is required");
  expectEqual(requireSupplementaryIdvSettingsActor(actorOf(["super_admin", "ceo"])).roles.length, 2, "a super_admin who also holds another role is allowed");

  // A denial is a denial for manual mode too.
  expectEqual(
    errorCodeOf(() => selectManualSupplementaryIdv(manualInput({ actor: actorOf(["compliance_kyc"]) }), settingsOptions(store))),
    "PERMISSION_DENIED",
    "compliance may not switch automatic verification off",
  );
  expectEqual(snapshotOf(store, COMPANY), before, "no denied call changed a configuration");
}

/* ---- section 3: the view ---- */

function checkView(): void {
  const empty = viewOf([]);
  expectEqual(empty.mode, "manual", "no configuration at all is manual mode");
  expectEqual(empty.activeVendorKey, null, "manual mode names no vendor");
  expectEqual(empty.activeCount, 0, "no row is active");
  expectEqual(empty.defect, false, "no configuration is not a defect");
  expectEqual(empty.vendors.length, 3, "all three vendors are listed");
  expectEqual(empty.vendors.map((row) => row.vendorKey).join(","), "jumio,didit,sumsub", "the vendors keep the catalogue order");
  expectEqual(empty.vendors.every((row) => row.configured === false), true, "nothing is configured");
  expectEqual(empty.vendors.every((row) => row.status === "not_configured"), true, "an absent row says not_configured");
  expectEqual(empty.vendors.every((row) => row.configId === null), true, "an absent row holds no id");
  expect(empty.reason.includes("no supplementary identity vendor is active") === true, "the reason says no vendor is active");

  const one = viewOf([
    configWith({ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" }),
  ]);
  expectEqual(one.mode, "automatic", "one active row is automatic mode");
  expectEqual(one.activeVendorKey, "sumsub", "the active vendor is named");
  expectEqual(one.defect, false, "one active row is not a defect");
  const sumsubRow = one.vendors.find((row) => row.vendorKey === "sumsub");
  expectEqual(sumsubRow?.configured, true, "the configured vendor is listed as configured");
  expectEqual(sumsubRow?.status, "active", "the configured vendor carries its status");
  expectEqual(sumsubRow?.activationProven, true, "an active row has proved its credentials");
  expectEqual(sumsubRow?.active, true, "an active row is active");
  expectEqual(sumsubRow?.environment, "live", "the row names its environment");
  expectEqual(one.vendors.filter((row) => row.vendorKey !== "sumsub").every((row) => row.active === false), true, "the other vendors are not active");

  const pending = viewOf([configWith({ id: "cfg_didit_live", vendorKey: "didit", status: "pending_activation" })]);
  expectEqual(pending.mode, "manual", "a configuration waiting for activation is not automatic mode");
  const pendingRow = pending.vendors.find((row) => row.vendorKey === "didit");
  expectEqual(pendingRow?.configured, true, "a pending row is configured");
  expectEqual(pendingRow?.status, "pending_activation", "a pending row carries its status");
  expectEqual(pendingRow?.activationProven, false, "a pending row has proved nothing");
  expectEqual(pendingRow?.configId, "cfg_didit_live", "a pending row is still named");

  const retired = viewOf([configWith({ id: "cfg_jumio_live", vendorKey: "jumio", status: "retired" })]);
  expectEqual(retired.mode, "manual", "a retired row is not automatic mode");
  expectEqual(retired.vendors.find((row) => row.vendorKey === "jumio")?.status, "retired", "a retired row is shown as retired");

  const defect = viewOf([
    configWith({ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" }),
    configWith({ id: "cfg_didit_live", vendorKey: "didit", status: "active" }),
  ]);
  expectEqual(defect.mode, "manual", "two active rows fall back to manual");
  expectEqual(defect.activeVendorKey, null, "two active rows choose neither vendor");
  expectEqual(defect.activeCount, 2, "the view counts both active rows");
  expectEqual(defect.defect, true, "two active rows are a visible defect");
  expect(defect.reason.includes("more than one") === true, "the reason says more than one vendor is active");

  // The mode is per environment: a live selection must not make the sandbox automatic, and the reverse.
  const environments = [
    configWith({ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active", environment: "live" }),
    configWith({ id: "cfg_didit_sandbox", vendorKey: "didit", status: "pending_activation", environment: "sandbox" }),
  ];
  const live = viewOf(environments, "live");
  const sandbox = viewOf(environments, "sandbox");
  expectEqual(live.mode, "automatic", "the live environment is automatic");
  expectEqual(live.activeVendorKey, "sumsub", "the live environment runs on the live vendor");
  expectEqual(sandbox.mode, "manual", "the sandbox environment is manual");
  expectEqual(sandbox.vendors.find((row) => row.vendorKey === "didit")?.status, "pending_activation", "the sandbox row is the sandbox one");
  expectEqual(sandbox.vendors.find((row) => row.vendorKey === "sumsub")?.configured, false, "the live row does not appear in the sandbox view");

  // Another company's rows never appear.
  const otherCompany = viewOf([
    configWith({ id: "cfg_other_sumsub", vendorKey: "sumsub", status: "active", companyId: OTHER_COMPANY }),
  ]);
  expectEqual(otherCompany.mode, "manual", "another company's active row does not make this company automatic");
  expectEqual(otherCompany.vendors.every((row) => row.configured === false), true, "another company's row is not listed");

  // Malformed input is a validation failure, not a silent empty view.
  expectEqual(
    errorCodeOf(() => supplementaryIdvSettingsOf({ companyId: "  ", environment: "live", configs: [] })),
    "VALIDATION_FAILED",
    "a blank company is a validation failure",
  );
  expectEqual(
    errorCodeOf(() => supplementaryIdvSettingsOf({ companyId: COMPANY, environment: "staging" as SupplementaryIdvEnvironment, configs: [] })),
    "VALIDATION_FAILED",
    "an unknown environment is a validation failure",
  );
}

/* ---- section 4: selecting one vendor ---- */

function checkSelection(): void {
  // Happy path: didit is active, sumsub becomes active and didit is retired in the same call.
  const store = storeOf([
    { id: "cfg_didit_live", vendorKey: "didit", status: "active" },
    { id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" },
  ]);
  const diditBefore = mustConfig(store, "cfg_didit_live");
  const sumsubBefore = mustConfig(store, "cfg_sumsub_live");
  const sink = auditSink();
  const selected = selectSupplementaryIdvVendor(selectInput(), settingsOptions(store, sink));
  expectEqual(selected.status, "selected", "selecting an active vendor retires the other one");
  if (selected.status === "selected") {
    expectEqual(selected.retiredConfigIds.join(","), "cfg_didit_live", "the other active row is the one retired");
    expectEqual(selected.view.mode, "automatic", "the company ends in automatic mode");
    expectEqual(selected.view.activeVendorKey, "sumsub", "the selected vendor is the active one");
    expectEqual(selected.view.activeCount, 1, "exactly one row is active afterwards");
    expectEqual(selected.view.defect, false, "the result is not a defect");
  }
  const diditAfter = mustConfig(store, "cfg_didit_live");
  expectEqual(diditAfter.status, "retired", "the other row is retired");
  expectEqual(diditAfter.version, diditBefore.version + 1, "the retired row moves one version");
  expectEqual(diditAfter.updatedAtEpochMs, NOW, "the retired row records when it was retired");
  expectEqual(diditAfter.createdAtEpochMs, diditBefore.createdAtEpochMs, "the retired row keeps its creation instant");
  expectEqual(diditAfter.credentialSealed, diditBefore.credentialSealed, "the retired row keeps its sealed credential byte for byte");
  expectEqual(diditAfter.webhookSecretSealed, diditBefore.webhookSecretSealed, "the retired row keeps its sealed delivery secret byte for byte");
  expectEqual(diditAfter.companyId, COMPANY, "the retired row keeps its company");
  expectEqual(diditAfter.vendorKey, "didit", "the retired row keeps its vendor");
  expectEqual(diditAfter.environment, "live", "the retired row keeps its environment");
  const sumsubAfter = mustConfig(store, "cfg_sumsub_live");
  expectEqual(sumsubAfter.status, "active", "the selected row stays active");
  expectEqual(sumsubAfter.version, sumsubBefore.version, "the selected row is not rewritten");
  expectEqual(sumsubAfter.credentialSealed, sumsubBefore.credentialSealed, "the selected row keeps its credential");

  expectEqual(sink.entries.length, 2, "one retirement and one selection are audited");
  expectEqual(sink.entries[0]?.action, "supplementary_idv.vendor_retired", "the retirement is audited first");
  expectEqual(sink.entries[0]?.vendorKey, "didit", "the retirement names the vendor it retired");
  expectEqual(sink.entries[0]?.configId, "cfg_didit_live", "the retirement names the row it retired");
  expectEqual(sink.entries[1]?.action, "supplementary_idv.vendor_selected", "the selection is audited after the retirement");
  const selectionEntry = sink.entries[1];
  if (selectionEntry !== undefined) {
    expectEqual(selectionEntry.vendorKey, "sumsub", "the selection names the vendor");
    expectEqual(selectionEntry.configId, "cfg_sumsub_live", "the selection names the row");
    expectEqual(selectionEntry.retiredConfigIds.join(","), "cfg_didit_live", "the selection lists what it retired");
    expectEqual(selectionEntry.actorUserId, SUPER_ADMIN_ID, "the selection names the actor");
    expectEqual(selectionEntry.companyId, COMPANY, "the selection names the company");
    expectEqual(selectionEntry.environment, "live", "the selection names the environment");
    expectEqual(selectionEntry.officeOnly, true, "the selection is an office entry");
    expectEqual(selectionEntry.reason, null, "a selection needs no refusal reason");
    expectEqual(selectionEntry.occurredAtEpochMs, NOW, "the selection records when it happened");
  expectEqual(sink.entries.every((entry) => entry.occurredAtEpochMs === NOW), true, "every entry records the same instant");
  expectEqual(sink.entries.every((entry) => entry.environment === "live"), true, "every entry names the environment");
  }

  // Three active rows: selecting one retires both others, in one call and with one audit entry each.
  const three = storeOf([
    { id: "cfg_didit_live", vendorKey: "didit", status: "active" },
    { id: "cfg_jumio_live", vendorKey: "jumio", status: "active" },
    { id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" },
  ]);
  const threeSink = auditSink();
  const threeResult = selectSupplementaryIdvVendor(selectInput(), settingsOptions(three, threeSink));
  expectEqual(threeResult.status, "selected", "selecting fixes a two-vendor defect");
  if (threeResult.status === "selected") {
    expectEqual(threeResult.retiredConfigIds.join(","), "cfg_didit_live,cfg_jumio_live", "both other active rows are retired");
    expectEqual(threeResult.view.activeCount, 1, "one row is left active");
  }
  expectEqual(three.listForCompany(COMPANY).filter((row) => row.status === "active").length, 1, "the store holds exactly one active row");
  expectEqual(threeSink.entries.length, 3, "two retirements and one selection are audited");
  expectEqual(threeSink.entries[2]?.action, "supplementary_idv.vendor_selected", "the selection is last");
  expectEqual(threeSink.entries[2]?.retiredConfigIds.length, 2, "the selection lists both retirements");

  // An already-correct selection writes nothing and audits nothing.
  const already = storeOf([{ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" }]);
  const alreadySink = auditSink();
  const alreadyResult = selectSupplementaryIdvVendor(selectInput(), settingsOptions(already, alreadySink));
  expectEqual(alreadyResult.status, "unchanged", "selecting the only active vendor changes nothing");
  expectEqual(alreadySink.entries.length, 0, "a repeated selection writes no audit entry");
  expectEqual(mustConfig(already, "cfg_sumsub_live").version, 2, "a repeated selection writes no row");

  // A vendor active in the other environment is not this environment's business.
  const twoEnvironments = storeOf([
    { id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active", environment: "live" },
    { id: "cfg_didit_sandbox", vendorKey: "didit", status: "active", environment: "sandbox" },
  ]);
  const environmentResult = selectSupplementaryIdvVendor(selectInput(), settingsOptions(twoEnvironments));
  expectEqual(environmentResult.status, "unchanged", "a live selection ignores the sandbox's active vendor");
  expectEqual(mustConfig(twoEnvironments, "cfg_didit_sandbox").status, "active", "the sandbox row stays active");

  // A second company's active row is never retired by this company's selection.
  const twoCompanies = storeOf([
    { id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" },
    { id: "cfg_didit_live", vendorKey: "didit", status: "active" },
    { id: "cfg_other_sumsub", vendorKey: "sumsub", status: "active", companyId: OTHER_COMPANY },
  ]);
  selectSupplementaryIdvVendor(selectInput(), settingsOptions(twoCompanies));
  expectEqual(mustConfig(twoCompanies, "cfg_other_sumsub").status, "active", "another company's active row is untouched");
  expectEqual(mustConfig(twoCompanies, "cfg_other_sumsub").version, 2, "another company's row is not rewritten");

  // Refusals: every one of them leaves the store exactly as it was and audits the refusal.
  const refusalCases: readonly { readonly name: string; readonly input: SelectSupplementaryIdvVendorInput; readonly reason: string }[] = [
    { name: "an unknown configuration id", input: selectInput({ configId: "cfg_missing" }), reason: "no configuration holds that id" },
    { name: "another company's configuration", input: selectInput({ configId: "cfg_other_sumsub" }), reason: "belongs to another company" },
    { name: "a configuration of another vendor", input: selectInput({ configId: "cfg_didit_live", vendorKey: "sumsub" }), reason: "is for didit" },
    { name: "a configuration of another environment", input: selectInput({ configId: "cfg_sumsub_live", environment: "sandbox" }), reason: "for the live environment" },
    { name: "a retired configuration", input: selectInput({ configId: "cfg_jumio_live", vendorKey: "jumio" }), reason: "retired configuration" },
  ];
  for (const refusal of refusalCases) {
    const refusalStore = storeOf([
      { id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" },
      { id: "cfg_didit_live", vendorKey: "didit", status: "active" },
      { id: "cfg_jumio_live", vendorKey: "jumio", status: "retired" },
      { id: "cfg_other_sumsub", vendorKey: "sumsub", status: "active", companyId: OTHER_COMPANY },
    ]);
    const refusalSink = auditSink();
    const refusalBefore = snapshotOf(refusalStore, COMPANY);
    const refused = selectSupplementaryIdvVendor(refusal.input, settingsOptions(refusalStore, refusalSink));
    expectEqual(refused.status, "refused", `selecting ${refusal.name} is refused`);
    if (refused.status === "refused") {
      expectEqual(refused.reason.includes(refusal.reason), true, `the refusal of ${refusal.name} says why`);
      expectEqual(refused.view.companyId, COMPANY, `the refusal of ${refusal.name} still returns this company's view`);
    }
    expectEqual(refusalSink.entries.length, 1, `the refusal of ${refusal.name} is audited once`);
    expectEqual(refusalSink.entries[0]?.action, "supplementary_idv.selection_refused", `the refusal of ${refusal.name} is audited as a refusal`);
    expect(refusalSink.entries[0]?.reason !== null, `the refusal of ${refusal.name} records a reason`);
    expectEqual(snapshotOf(refusalStore, COMPANY), refusalBefore, `the refusal of ${refusal.name} changes nothing`);
  }

  // A wrong vendor is refused before any credential is even considered.
  const wrongVendorStore = storeOf([{ id: "cfg_didit_live", vendorKey: "didit", status: "active" }]);
  expectEqual(
    selectSupplementaryIdvVendor(selectInput({ configId: "cfg_didit_live", vendorKey: "jumio" }), settingsOptions(wrongVendorStore)).status,
    "refused",
    "naming the wrong vendor for a configuration is refused",
  );

  // The property the title names, over every starting shape of the catalogue: whatever a company arrives with, a
  // selection leaves at most one active row and that row is the chosen vendor.
  for (const chosen of SUPPLEMENTARY_IDV_VENDOR_KEYS) {
    for (const neighbourStatus of ["active", "pending_activation", "retired"] as const) {
      const specs: ConfigSpec[] = [{ id: `cfg_${chosen}_live`, vendorKey: chosen, status: "active" }];
      for (const neighbour of SUPPLEMENTARY_IDV_VENDOR_KEYS) {
        if (neighbour === chosen) continue;
        specs.push({ id: `cfg_${neighbour}_live`, vendorKey: neighbour, status: neighbourStatus });
      }
      const matrixStore = storeOf(specs);
      const matrixResult = selectSupplementaryIdvVendor(
        selectInput({ vendorKey: chosen, configId: `cfg_${chosen}_live` }),
        settingsOptions(matrixStore),
      );
      expectEqual(
        matrixResult.status,
        neighbourStatus === "active" ? "selected" : "unchanged",
        `${chosen} beside a ${neighbourStatus} neighbour reports the right outcome`,
      );
      expectEqual(matrixResult.view.activeCount, 1, `${chosen} beside a ${neighbourStatus} neighbour leaves one active row`);
      expectEqual(matrixResult.view.activeVendorKey, chosen, `${chosen} beside a ${neighbourStatus} neighbour runs on the chosen vendor`);
      expectEqual(matrixStore.listForCompany(COMPANY).filter((row) => row.status === "active").length, 1, `${chosen} beside a ${neighbourStatus} neighbour leaves one active row in the store`);
    }
  }

  // Malformed input throws rather than being refused: a screen that sends nothing is a bug, not a business answer.
  expectEqual(errorCodeOf(() => selectSupplementaryIdvVendor(selectInput({ configId: "  " }), settingsOptions(store))), "VALIDATION_FAILED", "a blank configuration id is a validation failure");
  expectEqual(errorCodeOf(() => selectSupplementaryIdvVendor(selectInput({ companyId: "" }), settingsOptions(store))), "VALIDATION_FAILED", "a blank company is a validation failure");
  expectEqual(
    errorCodeOf(() => selectSupplementaryIdvVendor(selectInput({ vendorKey: "onfido" as SupplementaryIdvVendorKey }), settingsOptions(store))),
    "VALIDATION_FAILED",
    "a vendor outside the catalogue is a validation failure",
  );
  expectEqual(
    errorCodeOf(() => selectSupplementaryIdvVendor(selectInput({ environment: "staging" as SupplementaryIdvEnvironment }), settingsOptions(store))),
    "VALIDATION_FAILED",
    "an environment outside the catalogue is a validation failure",
  );

  // A lost race stops the selection and leaves the company in manual mode with the defect visible.
  const racingInner = storeOf([
    { id: "cfg_didit_live", vendorKey: "didit", status: "active" },
    { id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" },
  ]);
  const racingSink = auditSink();
  const raced = selectSupplementaryIdvVendor(selectInput(), settingsOptions(laggingStore(racingInner, "cfg_didit_live"), racingSink));
  expectEqual(raced.status, "failed", "a retirement that loses its version race fails the selection");
  if (raced.status === "failed") {
    expectEqual(raced.retiredConfigIds.length, 0, "nothing was retired before the race was lost");
    expect(raced.reason.includes("cfg_didit_live"), "the failure names the row that moved");
    expectEqual(raced.view.mode, "manual", "the company is left in manual mode");
    expectEqual(raced.view.defect, true, "the defect is left visible to the office");
  }
  expectEqual(mustConfig(racingInner, "cfg_didit_live").status, "active", "the raced row stays active");
  expectEqual(mustConfig(racingInner, "cfg_sumsub_live").status, "active", "the chosen row is not activated by force");
  expectEqual(racingSink.entries.length, 1, "a failed selection audits one refusal");
  expectEqual(racingSink.entries[0]?.action, "supplementary_idv.selection_refused", "the failure is audited as a refusal");

  // A partial retirement also fails, and still leaves no more than the two vendors it started with.
  const partialInner = storeOf([
    { id: "cfg_didit_live", vendorKey: "didit", status: "active" },
    { id: "cfg_jumio_live", vendorKey: "jumio", status: "active" },
    { id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" },
  ]);
  const partial = selectSupplementaryIdvVendor(selectInput(), settingsOptions(laggingStore(partialInner, "cfg_jumio_live")));
  expectEqual(partial.status, "failed", "a partial retirement fails the selection");
  if (partial.status === "failed") {
    expectEqual(partial.retiredConfigIds.join(","), "cfg_didit_live", "the rows retired before the failure are reported");
    expectEqual(partial.view.activeCount, 2, "two rows are left active");
    expectEqual(partial.view.mode, "manual", "two active rows fall back to manual");
    expectEqual(partial.view.defect, true, "the office sees the defect");
  }

  // A pending row can never be switched on by selecting it, however many rows are active.
  const pendingStore = storeOf([
    { id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" },
    { id: "cfg_didit_live", vendorKey: "didit", status: "pending_activation" },
  ]);
  const pendingResult = selectSupplementaryIdvVendor(selectInput({ configId: "cfg_didit_live", vendorKey: "didit" }), settingsOptions(pendingStore));
  expectEqual(pendingResult.status, "refused", "a pending row cannot be selected");
  expectEqual(mustConfig(pendingStore, "cfg_didit_live").status, "pending_activation", "the pending row stays pending");
  expectEqual(mustConfig(pendingStore, "cfg_sumsub_live").status, "active", "the active row is not retired for a refusal");
}

/* ---- section 5: manual mode on purpose ---- */

function checkManual(): void {
  const store = storeOf([
    { id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" },
    { id: "cfg_didit_live", vendorKey: "didit", status: "active" },
    { id: "cfg_jumio_sandbox", vendorKey: "jumio", status: "active", environment: "sandbox" },
  ]);
  const sink = auditSink();
  const selected = selectManualSupplementaryIdv(manualInput(), settingsOptions(store, sink));
  expectEqual(selected.status, "selected", "switching automatic verification off retires the active rows");
  if (selected.status === "selected") {
    expectEqual(selected.retiredConfigIds.join(","), "cfg_sumsub_live,cfg_didit_live", "both live rows are retired");
    expectEqual(selected.view.mode, "manual", "the company runs in manual mode");
    expectEqual(selected.view.activeVendorKey, null, "manual mode names no vendor");
    expectEqual(selected.view.activeCount, 0, "no row is active");
  }
  expectEqual(mustConfig(store, "cfg_jumio_sandbox").status, "active", "the sandbox row is untouched");
  expectEqual(sink.entries.length, 3, "two retirements and one manual selection are audited");
  expectEqual(sink.entries[2]?.action, "supplementary_idv.manual_selected", "the manual selection is audited last");
  expectEqual(sink.entries[2]?.vendorKey, null, "the manual selection names no vendor");
  expectEqual(sink.entries[2]?.configId, null, "the manual selection names no row");
  expectEqual(sink.entries[2]?.retiredConfigIds.length, 2, "the manual selection lists both retirements");
  expectEqual(sink.entries[2]?.actorUserId, SUPER_ADMIN_ID, "the manual selection names the actor");

  const emptyStore = storeOf([{ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "pending_activation" }]);
  const emptySink = auditSink();
  const unchanged = selectManualSupplementaryIdv(manualInput(), settingsOptions(emptyStore, emptySink));
  expectEqual(unchanged.status, "unchanged", "a company already in manual mode needs no change");
  expectEqual(emptySink.entries.length, 0, "no change writes no audit entry");
  expectEqual(mustConfig(emptyStore, "cfg_sumsub_live").status, "pending_activation", "the pending row is left alone");

  const racingInner = storeOf([{ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" }]);
  const raced = selectManualSupplementaryIdv(manualInput(), settingsOptions(laggingStore(racingInner, "cfg_sumsub_live")));
  expectEqual(raced.status, "failed", "a lost race fails the switch to manual mode");
  expectEqual(mustConfig(racingInner, "cfg_sumsub_live").status, "active", "a failed switch leaves the vendor active");
  expectEqual(errorCodeOf(() => selectManualSupplementaryIdv(manualInput({ companyId: " " }), settingsOptions(store))), "VALIDATION_FAILED", "a blank company is a validation failure");
}

/* ---- section 6: the fallback's two audiences ---- */

function checkFallback(): void {
  const automatic = viewOf([configWith({ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" })]);
  const automaticNote = supplementaryIdvManualFallbackOf(automatic);
  expectEqual(automaticNote.mode, "automatic", "an active vendor is automatic mode");
  expectEqual(automaticNote.vendorKey, "sumsub", "the fallback names the active vendor");
  expectEqual(automaticNote.defect, false, "one active vendor is not a defect");
  expect(automaticNote.officeNote.includes("Sumsub") === true, "the office note names the vendor by its own label");
  expectEqual(automaticNote.merchantVisibleVendor, false, "the merchant is shown no vendor");

  const manual = viewOf([configWith({ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "retired" })]);
  const manualNote = supplementaryIdvManualFallbackOf(manual);
  expectEqual(manualNote.mode, "manual", "no active vendor is manual mode");
  expectEqual(manualNote.vendorKey, null, "manual mode names no vendor");
  expect(manualNote.officeNote.includes("No supplementary identity vendor is active") === true, "the office note says no vendor is active");

  const defect = viewOf([
    configWith({ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" }),
    configWith({ id: "cfg_didit_live", vendorKey: "didit", status: "active" }),
  ]);
  const defectNote = supplementaryIdvManualFallbackOf(defect);
  expectEqual(defectNote.mode, "manual", "two active vendors fall back to manual");
  expectEqual(defectNote.defect, true, "the fallback reports the defect");
  expect(defectNote.officeNote.includes("Configuration defect") === true, "the office note names the defect");
  expect(defectNote.officeNote.includes("more than one supplementary identity vendor is active") === true, "the office note says what the defect is");

  // The merchant's sentence never moves, whatever the mode: the method is not the merchant's business.
  expectEqual(manualNote.merchantNote, automaticNote.merchantNote, "the merchant reads the same sentence in manual mode");
  expectEqual(defectNote.merchantNote, automaticNote.merchantNote, "the merchant reads the same sentence during a defect");
  for (const note of [automaticNote, manualNote, defectNote]) {
    expect(note.merchantNote.includes("Jumio") === false, "the merchant's sentence never names Jumio");
    expect(note.merchantNote.includes("Didit") === false, "the merchant's sentence never names Didit");
    expect(note.merchantNote.includes("Sumsub") === false, "the merchant's sentence never names Sumsub");
    expect(note.merchantNote.includes("automatic") === false, "the merchant's sentence never says automatic");
    expect(note.merchantNote.includes("manual") === false, "the merchant's sentence never says manual");
    expect(note.merchantNote.includes("vendor") === false, "the merchant's sentence never says vendor");
  }
  // The office note is the one place the vendor may be named, and it is office-only by construction.
  expect(defectNote.officeNote.includes("Sumsub") === false, "the defect note names the defect rather than the vendors");
}

/* ---- section 7: the office's queue ---- */

function checkOperations(): void {
  const store = storeOf([
    { id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" },
    { id: "cfg_didit_live", vendorKey: "didit", status: "active" },
  ]);
  const sumsub = mustConfig(store, "cfg_sumsub_live");
  const didit = mustConfig(store, "cfg_didit_live");
  const sessions = new InMemorySupplementaryIdvSessionStore();

  const fresh = openSessionIn(sessions, sumsub, NOW - HOUR_MS);
  const passed = answeredSessionIn(sessions, sumsub, { reference: "ref_pass_live", result: "passed" }, NOW - 2 * HOUR_MS);
  const failed = answeredSessionIn(sessions, didit, { reference: "ref_failed_live", result: "failed", reasonCode: "liveness_failed" }, NOW - 3 * HOUR_MS);
  const expired = answeredSessionIn(sessions, sumsub, { reference: "ref_expired_live", result: "expired", reasonCode: "session_expired" }, NOW - 4 * HOUR_MS);
  const stalled = openSessionIn(sessions, didit, NOW - 73 * HOUR_MS);
  const otherCompany = answeredSessionIn(
    sessions,
    configWith({ id: "cfg_other_sumsub", vendorKey: "sumsub", status: "active", companyId: OTHER_COMPANY }),
    { reference: "ref_other_company", result: "passed" },
    NOW - 5 * HOUR_MS,
  );
  const otherEnvironment = answeredSessionIn(
    sessions,
    configWith({ id: "cfg_sumsub_sandbox", vendorKey: "sumsub", status: "active", environment: "sandbox" }),
    { reference: "ref_sandbox", result: "passed" },
    NOW - 6 * HOUR_MS,
  );

  const board = supplementaryIdvOperationsOf({
    companyId: COMPANY,
    environment: "live",
    configs: store.listForCompany(COMPANY),
    sessions: [fresh, passed, failed, expired, stalled, otherCompany, otherEnvironment],
    processorKybStatus: "verified",
    nowEpochMs: NOW,
  });

  expectEqual(board.settings.mode, "manual", "the board shows the defect as manual mode");
  expectEqual(board.settings.defect, true, "the board shows the defect");
  expectEqual(board.processorKybStatus, "verified", "the processor's own status is shown as it is");
  expectEqual(board.processorKybAuthority, "processor", "the board names the processor as the authority");
  expectEqual(board.staleAfterMs, SUPPLEMENTARY_IDV_STALE_AFTER_MS, "the board uses the default deadline");
  expectEqual(board.manualQueue.length, 4, "four sessions are in the queue");
  expectEqual(board.stalledSessionIds.join(","), stalled.id, "only the old unfinished session is stalled");
  expectEqual(board.manualQueue.map((item) => item.sessionId).join(","), [stalled.id, expired.id, failed.id, passed.id].join(","), "the queue is oldest first");
  expectEqual(board.manualQueue[0]?.stalled, true, "the stalled item is marked stalled");
  expectEqual(board.manualQueue[0]?.result, "in_progress", "the stalled item is still in progress");
  expectEqual(board.manualQueue[0]?.requiresHumanReview, false, "a stalled row is flagged by the deadline, not by a recorded answer");
  expect(board.manualQueue[0] === undefined ? false : board.manualQueue[0].ageMs >= SUPPLEMENTARY_IDV_STALE_AFTER_MS, "the stalled item's age is past the deadline");
  const expiredItem = board.manualQueue[1];
  expectEqual(expiredItem?.merchantStatus, "verification_incomplete", "an expired session is incomplete for the merchant");
  expectEqual(expiredItem?.reasonCode, "session_expired", "the office sees the reason an expiry carried");
  expectEqual(expiredItem?.requiresHumanReview, true, "an unhappy outcome is a manual case");
  const failedItem = board.manualQueue[2];
  expectEqual(failedItem?.merchantStatus, "verification_incomplete", "a failed session is incomplete for the merchant");
  expectEqual(failedItem?.reasonCode, "liveness_failed", "the office sees the reason a failure carried");
  const passedItem = board.manualQueue[3];
  expectEqual(passedItem?.merchantStatus, "verification_complete", "a passed session is complete for the merchant");
  expectEqual(passedItem?.requiresHumanReview, false, "a passed session carries no fallback of its own");
  expectEqual(passedItem?.processorKybStatusSeen, "pending", "the session's processor snapshot is carried");
  expectEqual(board.manualQueue.every((item) => item.vendorKey === "sumsub" || item.vendorKey === "didit"), true, "the queue is this company's vendors only");
  expectEqual(board.manualQueue.some((item) => item.sessionId === fresh.id), false, "a fresh unfinished session is not in the queue");
  expectEqual(board.manualQueue.some((item) => item.sessionId === otherCompany.id), false, "another company's session is not in the queue");
  expectEqual(board.manualQueue.some((item) => item.sessionId === otherEnvironment.id), false, "another environment's session is not in the queue");

  // The deadline is a parameter: an hour-old session is stalled under a two hour deadline and not under three days.
  const shortDeadline = supplementaryIdvOperationsOf({
    companyId: COMPANY,
    environment: "live",
    configs: store.listForCompany(COMPANY),
    sessions: [fresh],
    processorKybStatus: null,
    nowEpochMs: NOW,
    staleAfterMs: HOUR_MS / 2,
  });
  expectEqual(shortDeadline.stalledSessionIds.join(","), fresh.id, "a shorter deadline stalls a younger session");
  expectEqual(shortDeadline.manualQueue.length, 1, "a stalled session enters the queue");
  const longDeadline = supplementaryIdvOperationsOf({
    companyId: COMPANY,
    environment: "live",
    configs: store.listForCompany(COMPANY),
    sessions: [fresh],
    processorKybStatus: null,
    nowEpochMs: NOW,
    staleAfterMs: 30 * DAY_MS,
  });
  expectEqual(longDeadline.stalledSessionIds.length, 0, "a longer deadline leaves it alone");

  // Malformed input is a validation failure.
  for (const staleAfterMs of [0, -1, 1.5, Number.NaN]) {
    expectEqual(
      errorCodeOf(() =>
        supplementaryIdvOperationsOf({
          companyId: COMPANY,
          environment: "live",
          configs: [],
          sessions: [],
          processorKybStatus: null,
          nowEpochMs: NOW,
          staleAfterMs,
        }),
      ),
      "VALIDATION_FAILED",
      `a staleAfterMs of ${asText(staleAfterMs)} is a validation failure`,
    );
  }
  expectEqual(
    errorCodeOf(() =>
      supplementaryIdvOperationsOf({ companyId: COMPANY, environment: "live", configs: [], sessions: [], processorKybStatus: null, nowEpochMs: 0 }),
    ),
    "VALIDATION_FAILED",
    "a zero clock is a validation failure",
  );
  expectEqual(
    errorCodeOf(() =>
      supplementaryIdvOperationsOf({ companyId: "", environment: "live", configs: [], sessions: [], processorKybStatus: null, nowEpochMs: NOW }),
    ),
    "VALIDATION_FAILED",
    "a blank company is a validation failure",
  );
}

/* ---- section 8: the gate ---- */

function checkGate(): void {
  const store = storeOf([{ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" }]);
  const config = mustConfig(store, "cfg_sumsub_live");
  const sessions = new InMemorySupplementaryIdvSessionStore();

  const inProgress = openSessionIn(sessions, config, NOW - HOUR_MS);
  const passed = answeredSessionIn(sessions, config, { reference: "ref_pass_gate", result: "passed" }, NOW - HOUR_MS);
  const failed = answeredSessionIn(sessions, config, { reference: "ref_failed_gate", result: "failed", reasonCode: "document_mismatch" }, NOW - HOUR_MS);
  const expired = answeredSessionIn(sessions, config, { reference: "ref_expired_gate", result: "expired", reasonCode: "session_expired" }, NOW - HOUR_MS);
  const unknown = unreachableSessionIn(sessions, config, NOW - HOUR_MS, "5c1f4f0e-1d2a-4c3b-8e9f-0a1b2c3d4e5f");

  const expectations: readonly { readonly session: SupplementaryIdvSession; readonly step: string; readonly phrase: string }[] = [
    { session: inProgress, step: "wait", phrase: "verification_in_progress" },
    { session: passed, step: "review_available", phrase: "verification_complete" },
    { session: failed, step: "manual_review", phrase: "verification_incomplete" },
    { session: expired, step: "manual_review", phrase: "verification_incomplete" },
    { session: unknown, step: "manual_review", phrase: "verification_incomplete" },
  ];
  for (const expectation of expectations) {
    const gate = supplementaryIdvProcessorGateOf(expectation.session);
    expectEqual(gate.step, expectation.step, `a ${expectation.session.result} session is at ${expectation.step}`);
    expectEqual(gate.merchantStatus, expectation.phrase, `a ${expectation.session.result} session reads ${expectation.phrase} to the merchant`);
    expectEqual(gate.changesProcessorKyb, false, `a ${expectation.session.result} session changes no processor status`);
    expectEqual(gate.requiresHumanDecision, true, `a ${expectation.session.result} session needs a person`);
    expectEqual(gate.processorKybAuthority, "processor", `a ${expectation.session.result} session names the processor as the authority`);
    expectEqual(gate.evidence.changesProcessorKyb, false, `the evidence of a ${expectation.session.result} session changes no processor status`);
    expectEqual(gate.evidence.requiresHumanDecision, true, `the evidence of a ${expectation.session.result} session needs a person`);
    expectEqual(gate.evidence.processorKybAuthority, "processor", `the evidence of a ${expectation.session.result} session names the processor`);
    expectEqual(gate.evidence.sessionId, expectation.session.id, `the evidence of a ${expectation.session.result} session names the session`);
    expectEqual(gate.evidence.processorKybStatusSeen, "pending", `the evidence of a ${expectation.session.result} session carries the snapshot`);
    expectEqual(gate.sessionId, expectation.session.id, `the gate of a ${expectation.session.result} session names the session`);
    expectEqual(gate.result, expectation.session.result, `the gate of a ${expectation.session.result} session carries the result`);
    expectEqual(gate.vendorKey, "sumsub", `the gate of a ${expectation.session.result} session carries the vendor`);
    expect(gate.officeMessage.length > 0, `the gate of a ${expectation.session.result} session has an office message`);
    expect(gate.evidence.reasonCode === expectation.session.reasonCode, `the evidence of a ${expectation.session.result} session carries its reason`);
  }

  expect(supplementaryIdvProcessorGateOf(passed).officeMessage.includes("unchanged") === true, "a pass says the processor status is unchanged");
  expect(supplementaryIdvProcessorGateOf(failed).officeMessage.includes("unchanged") === true, "a failure says the processor status is unchanged");
  expect(supplementaryIdvProcessorGateOf(expired).officeMessage.includes("unchanged") === true, "an expiry says the processor status is unchanged");
  expect(supplementaryIdvProcessorGateOf(inProgress).officeMessage.includes("still running") === true, "a running check says it is still running");
  expect(supplementaryIdvProcessorGateOf(passed).officeMessage.includes("reviewer") === true, "a pass is handed to a reviewer");

  // No evidence field ever holds a processor status written from the result.
  for (const expectation of expectations) {
    const gate = supplementaryIdvProcessorGateOf(expectation.session);
    const keys = Object.keys(gate.evidence).join(",");
    expectEqual(keys.includes("processorKybStatusSeen"), true, `the evidence of a ${expectation.session.result} session keeps the snapshot field`);
    expectEqual(keys.split(",").filter((key) => key === "processorKybStatus").length, 0, `the evidence of a ${expectation.session.result} session has no writable processor field`);
    expectEqual([gate.evidence.result as string].some((word) => word === "verified" || word === "rejected"), false, `the evidence of a ${expectation.session.result} session is not a processor word`);
  }
  expectEqual(SUPPLEMENTARY_IDV_RESULTS.map((word) => word as string).some((word) => word === "verified" || word === "rejected" || word === "restricted"), false, "the supplementary vocabulary still shares no word with the processor");
}

/* ---- section 9: every processor write is refused ---- */

function checkProcessorWrites(): void {
  const store = storeOf([{ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" }]);
  const config = mustConfig(store, "cfg_sumsub_live");
  const sessions = new InMemorySupplementaryIdvSessionStore();
  const passed = answeredSessionIn(sessions, config, { reference: "ref_pass_writes", result: "passed" }, NOW - HOUR_MS);
  const audits: SupplementaryIdvAuditEntry[] = [];
  const options = {
    sessionStore: sessions,
    occurredAtEpochMs: NOW,
    recordAudit: (entry: SupplementaryIdvAuditEntry) => {
      audits.push(entry);
    },
  };

  const candidates = [...PROCESSOR_KYB_STATUSES, "passed", "approved", "ok", "", "  "];
  for (const candidate of candidates) {
    const refused = attemptSupplementaryIdvProcessorWrite({ sessionId: passed.id, candidate, actor: SUPER_ADMIN }, options);
    expectEqual(refused.status, "refused", `writing ${candidate === "" ? "an empty word" : candidate} is refused`);
    expect(refused.reason.length > 0, `the refusal of ${candidate === "" ? "an empty word" : candidate} says why`);
    expectEqual(refused.gate?.sessionId, passed.id, `the refusal of ${candidate === "" ? "an empty word" : candidate} carries the gate`);
    expectEqual(refused.gate?.step, "review_available", `the refusal of ${candidate === "" ? "an empty word" : candidate} reads the session as evidence`);
    expectEqual(refused.gate?.changesProcessorKyb, false, `the refusal of ${candidate === "" ? "an empty word" : candidate} changes no processor status`);
    if (PROCESSOR_KYB_STATUSES.includes(candidate as (typeof PROCESSOR_KYB_STATUSES)[number])) {
      expect(refused.reason.includes("processor"), `the refusal of ${candidate} names the processor as the authority`);
    }
  }
  expectEqual(audits.length, candidates.length, "every attempt is audited once");
  expectEqual(audits.every((entry) => entry.action === "supplementary_idv.processor_write_refused"), true, "every entry is a refusal");
  expectEqual(audits.every((entry) => entry.officeOnly === true), true, "every refusal is an office entry");
  expectEqual(audits.every((entry) => entry.sessionId === passed.id), true, "every refusal names the session");
  expectEqual(audits.every((entry) => entry.companyId === COMPANY), true, "every refusal names the company");
  expectEqual(audits.every((entry) => entry.vendorKey === "sumsub"), true, "every refusal names the vendor");
  expectEqual(audits[0]?.result, PROCESSOR_KYB_STATUSES[0], "the refused candidate is recorded, not swallowed");
  expectEqual(audits[0]?.occurredAtEpochMs, NOW, "the refusal records when it happened");

  // The session is untouched by every attempt: no version, no result, no fallback.
  const after = mustSession(sessions, passed.id);
  expectEqual(after.version, passed.version, "a refused write leaves the session at the same version");
  expectEqual(after.result, "passed", "a refused write leaves the session result alone");
  expectEqual(after.requiresHumanReview, passed.requiresHumanReview, "a refused write leaves the human review flag alone");
  expectEqual(after.updatedAtEpochMs, passed.updatedAtEpochMs, "a refused write leaves the timestamp alone");

  // A missing session is refused without inventing one, and without an audit entry claiming a session.
  const before = audits.length;
  const missing = attemptSupplementaryIdvProcessorWrite({ sessionId: "sess_missing", candidate: "verified" }, options);
  expectEqual(missing.status, "refused", "a write against a missing session is refused");
  expectEqual(missing.gate, null, "a write against a missing session has no gate to show");
  expectEqual(audits.length, before, "a write against a missing session audits nothing");

  expectEqual(errorCodeOf(() => attemptSupplementaryIdvProcessorWrite({ sessionId: "  ", candidate: "verified" }, options)), "VALIDATION_FAILED", "a blank session id is a validation failure");

  // The actor is never consulted, even a super_admin on a passed session.
  const withCeo = attemptSupplementaryIdvProcessorWrite({ sessionId: passed.id, candidate: "verified", actor: actorOf(["ceo"]) }, options);
  expectEqual(withCeo.status, "refused", "a CEO's attempt is refused");
  const withoutActor = attemptSupplementaryIdvProcessorWrite({ sessionId: passed.id, candidate: "verified" }, options);
  expectEqual(withoutActor.status, "refused", "an attempt with no actor at all is refused");
}

/* ---- section 10: the merchant's three phrases ---- */

function checkMerchantView(): void {
  const store = storeOf([{ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" }]);
  const config = mustConfig(store, "cfg_sumsub_live");
  const sessions = new InMemorySupplementaryIdvSessionStore();
  const inProgress = openSessionIn(sessions, config, NOW - HOUR_MS);
  const passed = answeredSessionIn(sessions, config, { reference: "ref_pass_merchant", result: "passed" }, NOW - HOUR_MS);
  const failed = answeredSessionIn(sessions, config, { reference: "ref_failed_merchant", result: "failed", reasonCode: "document_unreadable" }, NOW - HOUR_MS);
  const expired = answeredSessionIn(sessions, config, { reference: "ref_expired_merchant", result: "expired", reasonCode: "session_expired" }, NOW - HOUR_MS);
  const unknown = unreachableSessionIn(sessions, config, NOW - HOUR_MS, "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");

  const views = supplementaryIdvMerchantViewOf([inProgress, passed, failed, expired, unknown]);
  expectEqual(views.length, 5, "every session is projected");
  expectEqual(views[0]?.status, "verification_in_progress", "a running session is in progress");
  expectEqual(views[1]?.status, "verification_complete", "a passed session is complete");
  expectEqual(views[2]?.status, "verification_incomplete", "a failed session is incomplete");
  expectEqual(views[3]?.status, "verification_incomplete", "an expired session is incomplete");
  expectEqual(views[4]?.status, "verification_incomplete", "an unreadable session is incomplete");
  expectEqual(views.every((view) => SUPPLEMENTARY_IDV_MERCHANT_STATUSES.includes(view.status)), true, "every phrase is one of the three");
  for (const view of views) {
    expectEqual(Object.keys(view).length, 2, "a merchant view holds an id and a phrase and nothing else");
    expectEqual(Object.keys(view).sort().join(","), "sessionId,status", "the two keys are the id and the status");
  }
  expectEqual(supplementaryIdvMerchantViewOf([]).length, 0, "no session projects to no view");
  const serialised = JSON.stringify(views);
  for (const vendor of ["jumio", "didit", "sumsub", "Jumio", "Didit", "Sumsub"]) {
    expect(serialised.includes(vendor) === false, `the merchant's view never names ${vendor}`);
  }
  for (const secret of ["documentKind", "reasonCode", "liveness", "reference", "processor", "passport"]) {
    expect(serialised.includes(secret) === false, `the merchant's view never carries ${secret}`);
  }
}

/* ---- section 11: this file never touches a session row ---- */

function checkSessionSilence(): void {
  // The operations view reads sessions and writes none: the same array is unchanged after the call.
  const store = storeOf([{ id: "cfg_sumsub_live", vendorKey: "sumsub", status: "active" }]);
  const sessions = new InMemorySupplementaryIdvSessionStore();
  const opened = openSessionIn(sessions, mustConfig(store, "cfg_sumsub_live"), NOW - 10 * HOUR_MS);
  const before = JSON.stringify(opened);
  supplementaryIdvOperationsOf({
    companyId: COMPANY,
    environment: "live",
    configs: store.listForCompany(COMPANY),
    sessions: [opened],
    processorKybStatus: "pending",
    nowEpochMs: NOW,
  });
  supplementaryIdvProcessorGateOf(opened);
  merchantProjectionOf(opened);
  expectEqual(JSON.stringify(mustSession(sessions, opened.id)), before, "reading a session leaves it byte for byte the same");
}

/** A tiny guard so the merchant projection is exercised against a real row as well. */
function merchantProjectionOf(session: SupplementaryIdvSession): void {
  const views = supplementaryIdvMerchantViewOf([session]);
  expectEqual(views.length, 1, "one row projects to one merchant view");
}

/* ---- section 12: the source ---- */

function checkSource(): void {
  const source = readFileSync(new URL("./supplementary-idv-settings.ts", import.meta.url), "utf8");
  expect([...source].every((char) => char.charCodeAt(0) <= 127), "the settings source is ASCII");
  const consoleNeedles = ["log", "error", "warn"].map((name) => ["console", `${name}(`].join("."));
  for (const needle of consoleNeedles) {
    expect(source.includes(needle) === false, "the settings source carries no console call");
  }
  expect(source.includes("process.env") === false, "the settings source reads no environment variable");
  expect(source.includes("await fetch(") === false, "the settings source calls no vendor");
  expect(source.includes("http://") === false, "the settings source never names plain HTTP");
  expect(source.includes("next/server") === false, "the settings source imports no route helper");
  expect(source.includes("migrations") === false, "the settings source knows nothing of the database layout");
  expect(source.includes("JSON.parse") === false, "the settings source parses nothing");
  expect(source.includes("node:crypto") === false, "the settings source hashes and encrypts nothing itself");

  // The permission is the platform's own helpers, not a re-implementation.
  expect(source.includes('import { hasSatisfiedTwoFactor, requireAnyRole } from "../../auth/session.ts"') === true, "the permission comes from the session helpers");
  expect(source.includes("requireAnyRole(actor, SUPPLEMENTARY_IDV_SETTINGS_ROLES)") === true, "the role check is the platform's");
  expect(source.includes("hasSatisfiedTwoFactor(actor)") === true, "the second factor check is the platform's");
  expect(source.indexOf("requireAnyRole(actor, SUPPLEMENTARY_IDV_SETTINGS_ROLES)") < source.indexOf("const config = options.configStore.findById(configId)"), "the actor is checked before a configuration is read");
  expect(source.indexOf("if (!hasSatisfiedTwoFactor(actor))") < source.indexOf("const config = options.configStore.findById(configId)"), "the second factor is checked before a configuration is read");

  // Only the status, the version and the timestamp of a configuration are ever written.
  expect(source.includes('status: "retired"') === true, "the one status this file writes is retired");
  expect(source.includes('status: "active"') === false, "this file never makes a row active by itself");
  expect(source.includes('status: "pending_activation"') === false, "this file never sends a row back to pending");
  expect(source.includes("credentialSealed:") === false, "this file writes no sealed credential");
  expect(source.includes("webhookSecretSealed:") === false, "this file writes no sealed delivery secret");
  expect(source.includes("version: other.version + 1") === true, "a retirement moves the version by one");
  expect(source.includes("version: row.version + 1") === true, "a manual retirement moves the version by one");
  expect(source.includes("options.configStore.save(next, other.version)") === true, "a retirement is a version-guarded write");
  expect(source.includes("options.configStore.save(next, row.version)") === true, "a manual retirement is a version-guarded write");
  expect(source.includes("options.configStore.insert") === false, "this file creates no configuration");
  expect(source.includes("openSupplementaryIdvSession") === false, "this file opens no session");

  // The processor gate is structural, not advisory.
  expect(source.includes("refuseProcessorKybWrite(candidate)") === true, "the attempt refuses through STEP 170's refusal");
  expect(source.includes("recordSupplementaryIdvProcessorWriteRefusal(") === true, "the attempt is audited through STEP 170's helper");
  expect(source.includes("changesProcessorKyb: false") === true, "the gate states that it changes no processor status");
  expect(source.includes("requiresHumanDecision: true") === true, "the gate states that a person decides");
  for (const processorWord of ["verified", "action_required", "restricted", "rejected"]) {
    expect(source.includes(`result: "${processorWord}"`) === false, `the settings source never writes ${processorWord} as a result`);
    expect(source.includes(`processorKybStatus: "${processorWord}"`) === false, `the settings source never writes ${processorWord} as a status`);
  }
  expect(source.includes("recordSupplementaryIdvAnswer(") === false, "this file records no vendor answer");
  expect(source.includes("sessionStore.save(") === false, "this file writes no session row");
  expect(source.includes("officeOnly: true") === true, "every audit entry is the office's");
  expect(source.includes("merchantNote") === true, "the fallback has a merchant sentence");
  expect(source.includes("merchantVisibleVendor: false") === true, "the fallback states that the merchant sees no vendor");

  // No personal data, and no credential, is named anywhere in the file.
  for (const personal of ["firstName", "first_name", "dateOfBirth", "date_of_birth", "documentNumber", "document_number", "email", "phone"]) {
    expect(source.includes(personal) === false, `the settings source never names the ${personal} field`);
  }
}

/* ---- running ---- */

checkConstants();
checkPermission();
checkView();
checkSelection();
checkManual();
checkFallback();
checkOperations();
checkGate();
checkProcessorWrites();
checkMerchantView();
checkSessionSilence();
checkSource();

if (failures.length > 0) {
  process.stderr.write(
    `supplementary idv settings gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `supplementary idv settings gate passed: ${checks} checks (only a super_admin with a second factor may select a vendor, selecting one retires every other active row of the same company and environment in the same call so at most one is ever active and a lost race stops the selection in manual mode instead of forcing a vendor on, a pending row cannot be selected and a retired row cannot be revived, manual mode is a deliberate retirement rather than an absence, every mode reaches the merchant as one unchanged sentence while the office reads the vendor or the defect, a stalled session is reported and never rewritten into an expiry because no reference was ever issued for it, a pass, a failure, an expiry and an unreadable answer all read as evidence with changesProcessorKyb false and a person decides, and every attempt to write a processor KYB status from supplementary code is refused and audited whatever the candidate and whoever the caller is)\n`,
);
