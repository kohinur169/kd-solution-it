// path: components/office/verify.ts
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import { SESSION_MANAGEMENT_OFFICE_ROLES } from "../../lib/auth/session-list.ts";
import { TWO_FACTOR_RESET_OFFICE_ROLES } from "../../lib/auth/two-factor-reset.ts";
import { PLATFORM_ROLES, isPlatformRole, type PlatformRole, type RequestActor } from "../../lib/auth/types.ts";
import { getMessage, type MessagePath } from "../../lib/i18n/messages.ts";
import { APPROVAL_QUEUE_ROLES } from "../../lib/approvals/registry.ts";
import { GATEWAY_MANAGEMENT_ROLES, OFFICE_DASHBOARD_ROLES } from "../../lib/gateways/registry.ts";
import {
  decideOfficeAccess,
  hasOfficeRole,
  isOfficeRole,
  officeAccessRedirect,
  officeRoleCharterKey,
  officeRoleLabelKey,
  officeRolesOf,
  officeSectionByHref,
  officeSectionByKey,
  officeSectionsFor,
  officeWorkspaceOf,
  OFFICE_HOME_PATH,
  OFFICE_NAVIGATION,
  OFFICE_ROLES,
  OFFICE_SIGN_IN_PATH,
  OFFICE_TWO_FACTOR_PATH,
  type OfficeActorState,
  type OfficeSectionKey,
} from "./navigation.ts";

/**
 * The office shell gate: run with `node components/office/verify.ts`.
 *
 * STEP 068 builds the one permission check every office screen inherits, so this gate is written
 * as a corpus of accounts rather than as a smoke test. It defends five properties that a review
 * cannot see and a demo will not show:
 *
 *   1. **One rule per screen.** The navigation imports the role list of the service behind each
 *      screen instead of restating it, and the gate compares the two, because a copy is the one
 *      thing that drifts. A screen offered to a role its service refuses is a door that opens onto
 *      a refusal; a screen hidden from a role its service accepts is a feature nobody can reach.
 *   2. **Every destination exists.** Each entry is resolved to a `page.tsx` in the app tree, so the
 *      sidebar cannot promise a 404 - the office STEPs after this one add their entry with their
 *      page.
 *   3. **The office is staff only.** Anonymous, unreadable, merchant and officer-without-a-second-
 *      factor accounts each take one path, in one order, decided by one function.
 *   4. **One landmark each.** One `<main>`, one `<nav>`, one `<header>`: a second landmark is a
 *      navigation a keyboard user has to pass twice.
 *   5. **Both themes, both widths, no hidden links.** Colour only through tokens, one DOM reflowed
 *      at `lg`, no fixed pixel width and nothing removed from the tab order on a phone.
 *
 * The model is executed and the components are read. A `.tsx` file cannot be imported by plain
 * Node, so the markup contract is asserted against the source text exactly as `verify-shell.mjs`
 * does for the root layout, while everything that decides an answer is called.
 */

const repositoryRoot = new URL("../../", import.meta.url);

const failures: string[] = [];
let checks = 0;

function expect(condition: boolean, description: string): void {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

async function readRepositoryFile(repositoryPath: string): Promise<string> {
  return readFile(new URL(repositoryPath, repositoryRoot), "utf8");
}

/** An actor record of `lib/auth`, complete so a test cannot pass by leaving a field out. */
function actorOf(roles: readonly PlatformRole[], overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: "018f2b8a-4444-4c2d-9c3e-0123456789ab",
    companyId: roles.includes("owner") ? "018f2b8a-5555-4c2d-9c3e-0123456789ab" : null,
    roles,
    sessionId: "018f2b8a-6666-4c2d-9c3e-0123456789ab",
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: 1_800_000_000_000,
    expiresAtEpochMs: 1_800_000_900_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    deviceProofKeyId: null,
    sessionFamilyId: null,
    mfaVerifiedAtEpochMs: 1_800_000_000_000,
    reauthenticatedAtEpochMs: null,
    ...overrides,
  };
}

function stateOf(roles: readonly PlatformRole[], overrides: Partial<RequestActor> = {}): OfficeActorState {
  return { kind: "actor", actor: actorOf(roles, overrides) };
}

const sectionKeysOf = (keys: readonly OfficeSectionKey[]): string => keys.join(",");

function sectionsOf(roles: readonly PlatformRole[]): string {
  return officeSectionsFor(roles)
    .map((section) => section.key)
    .join(",");
}

/** ---- The roles: the seven of section 2 minus the merchant. */
function checkRoles(): void {
  expectEqual(
    OFFICE_ROLES.join(","),
    "super_admin,ceo,compliance_kyc,finance_ops,support,blogger",
    "the office is the six platform roles, in the migration's order",
  );
  expectEqual(OFFICE_ROLES.length, 6, "and it is six");
  expect(Object.isFrozen(OFFICE_ROLES), "the list is frozen");
  expectEqual(new Set<string>(OFFICE_ROLES).size, OFFICE_ROLES.length, "with no role twice");
  expectEqual(
    OFFICE_ROLES.join(","),
    PLATFORM_ROLES.filter((role) => role !== "owner").join(","),
    "and it is derived from the seven, not written out a second time",
  );

  for (const role of OFFICE_ROLES) {
    expect(isPlatformRole(role), `${role} is one of the seven roles`);
    expect(isOfficeRole(role), `${role} is an office role`);
  }

  expectEqual(isOfficeRole("owner"), false, "the merchant role is not an office role");
  expectEqual(isOfficeRole("client"), false, "a client holds no role at all");
  expectEqual(isOfficeRole(""), false, "and an empty string is nobody");
  expectEqual(isOfficeRole(null), false, "nor is null");
  expectEqual(isOfficeRole(42), false, "nor a number");
}

/** ---- The section catalog: six screens, each with the roles its service enforces. */
function checkCatalog(): void {
  expectEqual(OFFICE_NAVIGATION.length, 6, "six office screens exist");
  expect(Object.isFrozen(OFFICE_NAVIGATION), "the catalog is frozen");
  expectEqual(
    OFFICE_NAVIGATION.map((section) => section.key).join(","),
    "workspace,dashboard,ceo,gateways,sessions,twoFactorResets",
    "in the order the sidebar shows them",
  );
  expectEqual(
    new Set<string>(OFFICE_NAVIGATION.map((section) => section.key)).size,
    OFFICE_NAVIGATION.length,
    "each key once",
  );
  expectEqual(
    new Set<string>(OFFICE_NAVIGATION.map((section) => section.href)).size,
    OFFICE_NAVIGATION.length,
    "each address once",
  );

  for (const section of OFFICE_NAVIGATION) {
    expect(section.href.startsWith("/"), `${section.key} is an absolute path`);
    expectEqual(section.href.includes("?"), false, `${section.key} carries no query string`);
    expectEqual(section.href.includes("#"), false, `${section.key} carries no fragment`);
    expectEqual(section.href.endsWith("/"), false, `${section.key} is not a trailing slash duplicate`);
    expectEqual(section.href === "/", false, `${section.key} is not the public home page`);
    expect(Object.isFrozen(section.roles), `${section.key} has a frozen role list`);
    expect(section.roles.length > 0, `${section.key} is open to at least one role`);

    for (const role of section.roles) {
      expect(isOfficeRole(role), `${section.key} names ${role}, which is an office role`);
    }

    expect(getMessage(section.labelKey).length > 0, `${section.key} has a label in the catalog`);
    expect(getMessage(section.descriptionKey).length > 0, `${section.key} has a description in the catalog`);
    expect(
      getMessage(section.labelKey) !== getMessage(section.descriptionKey),
      `${section.key} does not use its label as its description`,
    );
  }

  // The one rule the shell must not restate: each screen's roles are the constant its service uses.
  expectEqual(
    officeSectionByKey("sessions")?.roles.join(","),
    SESSION_MANAGEMENT_OFFICE_ROLES.join(","),
    "the sessions entry carries the role list of the sessions service",
  );
  expectEqual(
    officeSectionByKey("twoFactorResets")?.roles.join(","),
    TWO_FACTOR_RESET_OFFICE_ROLES.join(","),
    "and the reset queue entry carries the role list of the reset service",
  );
  expectEqual(
    officeSectionByKey("workspace")?.roles.join(","),
    OFFICE_ROLES.join(","),
    "while the workspace index is open to every office role",
  );
  expectEqual(
    officeSectionByKey("dashboard")?.roles.join(","),
    OFFICE_DASHBOARD_ROLES.join(","),
    "the office home carries the role list of section 6's dashboard",
  );
  expectEqual(
    officeSectionByKey("ceo")?.roles.join(","),
    APPROVAL_QUEUE_ROLES.join(","),
    "the CEO home carries the role list of the approval service",
  );
  expectEqual(
    officeSectionByKey("gateways")?.roles.join(","),
    GATEWAY_MANAGEMENT_ROLES.join(","),
    "and the gateway entry carries the role list of the gateway service",
  );
  expectEqual(
    GATEWAY_MANAGEMENT_ROLES.join(","),
    "super_admin",
    "section 6 keeps the gateway page to the super administrator",
  );
  expectEqual(
    OFFICE_DASHBOARD_ROLES.join(","),
    "super_admin",
    "and the home that summarises it to the same role",
  );

  expectEqual(officeSectionByKey("workspace")?.key, "workspace", "a section is found by key");
  expectEqual(officeSectionByKey("audit" as OfficeSectionKey), null, "and an unknown key is nothing");
  expectEqual(officeSectionByHref(OFFICE_HOME_PATH)?.key, "workspace", "and by the address it is served at");
  expectEqual(officeSectionByHref("/nowhere"), null, "and an unknown address is nothing");
}

/** ---- Which roles see which screen. */
function checkRoleFiltering(): void {
  const expected: Readonly<Record<PlatformRole, string>> = {
    super_admin: "workspace,dashboard,ceo,gateways,sessions,twoFactorResets",
    ceo: "workspace,ceo,sessions,twoFactorResets",
    compliance_kyc: "workspace,sessions,twoFactorResets",
    finance_ops: "workspace",
    support: "workspace,sessions,twoFactorResets",
    blogger: "workspace",
    owner: "",
  };

  for (const role of PLATFORM_ROLES) {
    expectEqual(sectionsOf([role]), expected[role], `${role} sees exactly the screens its services allow`);
  }

  expectEqual(sectionsOf([]), "", "an account with no role sees no office screen");
  expectEqual(sectionsOf(["owner"]), "", "and a merchant sees none of them either");
  expectEqual(sectionsOf(["owner", "blogger"]), "workspace", "a second merchant role adds nothing");
  expectEqual(
    sectionsOf(["blogger", "support"]),
    "workspace,sessions,twoFactorResets",
    "two roles are the union of what each may open",
  );
  expectEqual(
    sectionsOf(["support", "super_admin"]),
    "workspace,dashboard,ceo,gateways,sessions,twoFactorResets",
    "and the union is not counted twice",
  );
  expectEqual(sectionKeysOf(officeSectionsFor(["ceo"]).map((section) => section.key)), "workspace,ceo,sessions,twoFactorResets", "the catalog order is stable");

  expectEqual(officeRolesOf(["blogger", "super_admin"]).join(","), "super_admin,blogger", "the roles of an account come back in the migration's order");
  expectEqual(officeRolesOf(["owner"]).join(","), "", "and the merchant role is not one of them");
  expectEqual(officeRolesOf(["ceo", "ceo"]).join(","), "ceo", "a role listed twice is one role");

  for (const role of OFFICE_ROLES) {
    expect(hasOfficeRole([role]), `${role} holds office access`);
  }

  expectEqual(hasOfficeRole(["owner"]), false, "an owner does not");
  expectEqual(hasOfficeRole([]), false, "nor does an account with nothing");
}

/** ---- The one decision: five outcomes, one order. */
function checkAccessDecision(): void {
  const anonymous = decideOfficeAccess({ kind: "anonymous" });

  expectEqual(anonymous.kind, "sign-in", "an anonymous request is sent to the sign in form");
  expectEqual(officeAccessRedirect(anonymous), OFFICE_SIGN_IN_PATH, "and the path is the named one");

  const unavailable = decideOfficeAccess({ kind: "unavailable" });

  expectEqual(unavailable.kind, "unavailable", "an account that cannot be read is an outage");
  expectEqual(officeAccessRedirect(unavailable), null, "and is neither a sign in nor a redirect");

  const merchant = decideOfficeAccess(stateOf(["owner"]));

  expectEqual(merchant.kind, "denied", "a merchant is refused the office");
  expectEqual(officeAccessRedirect(merchant), null, "and is shown the refusal instead of being sent away");

  const noRoles = decideOfficeAccess(stateOf([]));

  expectEqual(noRoles.kind, "denied", "an account with no role is refused too");

  const owingAFactor = decideOfficeAccess(stateOf(["support"], { twoFactorEnrolmentRequired: true, twoFactorSatisfied: false }));

  expectEqual(owingAFactor.kind, "two-factor", "an officer who still owes a second factor goes to enrolment");
  expectEqual(officeAccessRedirect(owingAFactor), OFFICE_TWO_FACTOR_PATH, "at the enrolment screen");

  const merchantOwingAFactor = decideOfficeAccess(stateOf(["owner"], { twoFactorEnrolmentRequired: true }));

  expectEqual(
    merchantOwingAFactor.kind,
    "denied",
    "but a merchant is refused before the second factor question, because the office is not theirs to enrol into",
  );

  const allowed = decideOfficeAccess(stateOf(["support"]));

  expectEqual(allowed.kind, "allowed", "an officer with a second factor enters");
  expectEqual(
    allowed.kind === "allowed" ? allowed.roles.join(",") : "",
    "support",
    "with the office roles the account holds",
  );
  expectEqual(
    allowed.kind === "allowed" ? allowed.sections.map((section) => section.key).join(",") : "",
    "workspace,sessions,twoFactorResets",
    "and the screens those roles open",
  );
  expectEqual(officeAccessRedirect(allowed), null, "the shell renders instead of redirecting");

  const multi = decideOfficeAccess(stateOf(["owner", "blogger", "ceo"]));

  expectEqual(multi.kind === "allowed" ? multi.roles.join(",") : "", "ceo,blogger", "the merchant grant is ignored and the two office roles are kept");
  expectEqual(
    multi.kind === "allowed" ? multi.sections.length : -1,
    4,
    "and the screens are the union of the two",
  );

  for (const role of OFFICE_ROLES) {
    const decision = decideOfficeAccess(stateOf([role]));

    expect(decision.kind === "allowed", `${role} with a second factor enters the office`);
  }
}

/** ---- The workspace index: what the entry page renders for one account. */
function checkWorkspaceView(): void {
  expectEqual(officeWorkspaceOf(["owner"]), null, "a merchant has no workspace view");
  expectEqual(officeWorkspaceOf([]), null, "and neither has an account with no role");

  const view = officeWorkspaceOf(["ceo"]);

  expect(view !== null, "an officer has one");
  expectEqual(view === null ? "" : view.roles.length, 1, "with one role");
  expectEqual(view === null ? "" : view.roles[0]?.role, "ceo", "which is the role held");
  expectEqual(view === null ? "" : view.roles[0]?.labelKey, "office.roleCeo", "with its catalog label");
  expectEqual(view === null ? "" : view.roles[0]?.charterKey, "office.charterCeo", "and its charter");
  expectEqual(view === null ? "" : view.sections.length, 4, "and the screens it opens");

  const two = officeWorkspaceOf(["support", "finance_ops"]);

  expectEqual(
    two === null ? "" : two.roles.map((role) => role.role).join(","),
    "finance_ops,support",
    "two roles are listed in the migration's order",
  );
  expectEqual(two === null ? "" : two.sections.length, 3, "and the screens are the union");

  const expectedLabelKeys: Readonly<Record<PlatformRole, string>> = {
    super_admin: "office.roleSuperAdmin",
    ceo: "office.roleCeo",
    compliance_kyc: "office.roleComplianceKyc",
    finance_ops: "office.roleFinanceOps",
    support: "office.roleSupport",
    blogger: "office.roleBlogger",
    owner: "",
  };
  const expectedCharterKeys: Readonly<Record<PlatformRole, string>> = {
    super_admin: "office.charterSuperAdmin",
    ceo: "office.charterCeo",
    compliance_kyc: "office.charterComplianceKyc",
    finance_ops: "office.charterFinanceOps",
    support: "office.charterSupport",
    blogger: "office.charterBlogger",
    owner: "",
  };
  const charters = new Set<string>();
  const labels = new Set<string>();

  for (const role of OFFICE_ROLES) {
    expectEqual(officeRoleLabelKey(role), expectedLabelKeys[role], `${role} has its own label key`);
    expectEqual(officeRoleCharterKey(role), expectedCharterKeys[role], `${role} has its own charter key`);
    expect(getMessage(officeRoleLabelKey(role)).length > 0, `${role} has a label`);
    expect(getMessage(officeRoleCharterKey(role)).length > 0, `${role} has a charter`);

    charters.add(getMessage(officeRoleCharterKey(role)));
    labels.add(getMessage(officeRoleLabelKey(role)));
  }

  expectEqual(charters.size, OFFICE_ROLES.length, "six roles, six charters: no copy and paste");
  expectEqual(labels.size, OFFICE_ROLES.length, "and six names");
}

/** ---- Every destination exists: the sidebar cannot promise a 404. */
async function collectRoutes(directory: URL, prefix: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const routes: string[] = [];

  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);

    if (entry.isDirectory()) {
      // A route group is a folder that is not in the address (`app/(admin)/admin` is `/admin`).
      const segment = /^\(.+\)$/u.test(entry.name) ? prefix : `${prefix}/${entry.name}`;

      routes.push(...(await collectRoutes(child, segment)));
      continue;
    }

    if (entry.name === "page.tsx" || entry.name === "page.ts") {
      routes.push(prefix.length === 0 ? "/" : prefix);
    }
  }

  return routes;
}

async function checkDestinations(): Promise<void> {
  const routes = await collectRoutes(new URL("app/", repositoryRoot), "");

  expect(routes.includes("/"), "the public home page exists");

  for (const section of OFFICE_NAVIGATION) {
    expect(routes.includes(section.href), `${section.key} is a page that exists (${section.href})`);
  }

  expect(routes.includes(OFFICE_HOME_PATH), "the workspace index is a page that exists");
  expect(routes.includes(OFFICE_SIGN_IN_PATH), "the sign in form this shell redirects to exists");
  expect(routes.includes(OFFICE_TWO_FACTOR_PATH), "and so does the enrolment screen it redirects to");
  expect(routes.includes("/office/sessions"), "the sessions screen of the authentication block still exists");
  expect(routes.includes("/office/2fa-reset-requests"), "and so does the reset queue");
}

/** ---- The source contract: one gate, one landmark each, no hidden link, no literal. */
async function checkShellSource(): Promise<void> {
  const layout = await readRepositoryFile("app/(admin)/layout.tsx");
  const page = await readRepositoryFile("app/(admin)/admin/page.tsx");
  const actor = await readRepositoryFile("app/(admin)/office-actor.ts");
  const model = await readRepositoryFile("components/office/navigation.ts");
  const shell = await readRepositoryFile("components/office/admin-shell.tsx");
  const nav = await readRepositoryFile("components/office/office-nav.tsx");
  const panel = await readRepositoryFile("components/office/office-access-panel.tsx");

  const sources: readonly (readonly [string, string])[] = [
    ["app/(admin)/layout.tsx", layout],
    ["app/(admin)/admin/page.tsx", page],
    ["app/(admin)/office-actor.ts", actor],
    ["components/office/navigation.ts", model],
    ["components/office/admin-shell.tsx", shell],
    ["components/office/office-nav.tsx", nav],
    ["components/office/office-access-panel.tsx", panel],
  ];

  for (const [path, source] of sources) {
    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path on its first line`);
    expectEqual(source.includes("dangerouslySetInnerHTML"), false, `${path} writes no markup from a string`);
    expectEqual(source.includes("console."), false, `${path} logs nothing`);
    expectEqual(source.includes("process.env"), false, `${path} reads no environment variable`);
    expectEqual(/:\s*any\b/u.test(source), false, `${path} writes no any`);
    expectEqual(/https?:\/\//u.test(source), false, `${path} names no absolute URL`);
  }

  // ---- the layout is the gate, and it is a thin one
  expect(layout.includes('from "./office-actor"'), "the layout reads the account through the cached reader");
  expect(
    layout.includes("decideOfficeAccess(await readOfficeActor())"),
    "and asks the one decision function about the account it just read",
  );
  expect(layout.includes("officeAccessRedirect"), "which names where a refusal goes");
  expect(layout.includes("redirect(destination)"), "and sends the browser there");
  expect(layout.includes('export const dynamic = "force-dynamic"'), "the office is rendered per request");
  expect(layout.includes('if (access.kind === "allowed") {'), "only an allowed account reaches the shell branch");
  expect(
    layout.includes('access.kind === "denied" ? "denied" : "unavailable"'),
    "and the two other outcomes keep their own panel",
  );
  expect(layout.includes("<AdminShell"), "an allowed account gets the shell");
  expect(layout.includes("<OfficeAccessPanel"), "and a refused one gets the panel");
  expectEqual(layout.includes("<main"), false, "the layout renders no landmark of its own");
  expectEqual(layout.includes("<nav"), false, "so the shell stays the only navigation");
  expectEqual(layout.includes("super_admin"), false, "and the layout names no role: the decision function does");
  expectEqual(layout.includes("roles.includes("), false, "no ad hoc role comparison");
  expectEqual(layout.includes("requireAnyRole"), false, "and no second permission helper");

  // ---- the account reader: one read per request, and an outage is not anonymity
  expect(actor.includes("cache(async"), "the account is read once per request");
  expect(actor.includes('headers()).get("cookie")'), "from the request cookie");
  expect(actor.includes("getAuthRuntime"), "with the authentication runtime");
  expect(actor.includes("readRequestActor"), "resolved by STEP 051's bound session reader");
  expect(actor.includes('"AUTHENTICATION_REQUIRED"'), "a refusal is the anonymous state");
  expect(actor.includes("throw error"), "and a defect that is not an AppError is not swallowed");
  expectEqual(actor.includes('{ kind: "unavailable" }'), true, "while an outage is its own state");

  // ---- the model: the permission lists are the auth module's, never a copy
  expect(model.includes('from "../../lib/auth/session-list.ts"'), "the model imports the sessions role list");
  expect(model.includes('from "../../lib/auth/two-factor-reset.ts"'), "and the reset queue role list");
  expect(model.includes("SESSION_MANAGEMENT_OFFICE_ROLES"), "using the constant itself");
  expect(model.includes("TWO_FACTOR_RESET_OFFICE_ROLES"), "and the other one");
  expectEqual(/roles:\s*\[/u.test(model), false, "no screen spells a role list inline");
  expect(
    model.includes("roles: SESSION_MANAGEMENT_OFFICE_ROLES,"),
    "the sessions entry takes the sessions service's list by name",
  );
  expect(
    model.includes("roles: TWO_FACTOR_RESET_OFFICE_ROLES,"),
    "and the reset queue entry takes the reset service's list, so the two cannot be swapped while they agree",
  );

  for (const role of OFFICE_ROLES) {
    const occurrences = (model.match(new RegExp(`\\b${role}:`, "gu")) ?? []).length;

    expectEqual(occurrences, 2, `${role} is named only in its label key and its charter key`);
  }

  expectEqual(model.includes('"owner"'), true, "the merchant role is excluded by name");

  // ---- the shell: one landmark each, one DOM, no fixed width
  expectEqual(shell.split("<header className={headerClasses}>").length - 1, 1, "the shell has one topbar");
  expectEqual(shell.split("<aside className={sidebarClasses}>").length - 1, 1, "and one sidebar");
  expectEqual(shell.split("<main className={contentClasses}>").length - 1, 1, "exactly one content landmark");
  expectEqual(shell.includes("<nav"), false, "the navigation is its own component");
  expect(shell.includes("<OfficeNav"), "which the shell renders");
  expect(shell.includes("<SessionKeeper />"), "the session keeps rotating on every office screen");
  expect(shell.includes("<ThemeToggle"), "and the theme switcher is the shared one");
  expect(shell.includes("getMessage"), "every label comes from the catalog");
  expect(
    /const contentClasses = "[^"]*min-w-0/u.test(shell),
    "the content column may shrink, so a wide table cannot push the sidebar away",
  );
  expect(shell.includes("lg:flex-row"), "the body becomes a row on a wide screen");
  expect(shell.includes("lg:w-64"), "with a fixed sidebar width only from lg upwards");
  expect(shell.includes("max-w-7xl"), "and a reading width for the whole shell");
  expectEqual(/w-\[/u.test(shell), false, "no arbitrary width");
  expectEqual(shell.includes("style="), false, "and no inline style");
  expectEqual(shell.includes('id="main-content"'), false, "the skip link target stays the root layout's one element");

  // ---- the navigation: one list, two shapes, nothing hidden
  // The directive is assembled rather than written out: this gate lives under `components/`, and
  // `scripts/verify-shell.mjs` treats any file there that spells it as a browser bundle.
  const clientDirective = `"use ${"client"}";`;

  expectEqual(nav.split("\n")[1], clientDirective, "the navigation is the one client boundary, because only a browser knows its address");
  expect(nav.includes("usePathname"), "it reads the current path");
  expect(nav.includes('{ "aria-current": "page" as const }'), "and marks the current entry");
  expectEqual(nav.split("<nav").length - 1, 1, "one navigation landmark");
  expect(nav.includes("aria-label"), "with an accessible name");
  expectEqual(nav.split("<ul").length - 1, 1, "one list");
  expectEqual(nav.split("<li").length - 1, 1, "one item shape");
  expectEqual(nav.split("<Link").length - 1, 1, "one link shape, rendered once per entry");
  expect(nav.includes("overflow-x-auto"), "a narrow screen scrolls the list sideways");
  expect(nav.includes("lg:flex-col"), "and a wide one stacks it");
  expectEqual(nav.includes("hidden"), false, "nothing is hidden at any width");
  expectEqual(nav.includes("aria-hidden"), false, "and nothing is hidden from a screen reader either");
  expectEqual(nav.includes("tabIndex"), false, "no entry leaves the tab order");
  expectEqual(nav.includes("onClick"), false, "a link needs no handler");
  expectEqual(nav.includes('from "@/lib/i18n'), false, "the labels arrive already translated, so the catalog stays out of the browser bundle");
  expectEqual(nav.includes("target="), false, "no link opens a new tab");

  // ---- the panel: a refusal is its own screen, not an empty shell
  expectEqual(panel.split("<main className={mainClasses}>").length - 1, 1, "the refusal panel has its own content landmark");
  expectEqual(panel.split("<h1 className={titleClasses}>").length - 1, 1, "one heading");
  expect(panel.includes("accessDeniedTitle"), "the refusal is worded in the catalog");
  expect(panel.includes("unavailableTitle"), "and so is the outage");
  expect(panel.includes('href="/"'), "both panels offer the way home");

  // ---- the page: the layout's gate, asked again, and nothing promised
  expect(page.includes("officeWorkspaceOf"), "the index renders the workspace model");
  expect(page.includes("decideOfficeAccess"), "and refuses on its own if it is ever rendered alone");
  expectEqual(page.includes("<main"), false, "the page renders no landmark: the shell owns it");
  expectEqual(page.includes("super_admin"), false, "and names no role");
  expectEqual(page.includes("<dl"), true, "the charters are a description list");
  expect(page.includes('id="office-duties"'), "each section is named by its heading");
  expect(page.includes('id="office-sections"'), "and the destinations have their own");

  // ---- one office navigation in the tree
  const roleNamers: string[] = [];

  for (const root of ["app", "components"]) {
    for (const file of await collectSources(new URL(`${root}/`, repositoryRoot), `${root}/`)) {
      if (file === "components/office/verify.ts") {
        continue;
      }

      const source = await readFile(new URL(file, repositoryRoot), "utf8");

      if (source.includes("super_admin")) {
        roleNamers.push(file);
      }
    }
  }

  expectEqual(
    roleNamers.sort().join(","),
    "components/office/navigation.ts",
    "one file in the tree names the office roles",
  );
}

/** Every `.ts` and `.tsx` file under a root, as repository paths. */
async function collectSources(directory: URL, prefix: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = `${prefix}${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await collectSources(new URL(`${entry.name}/`, directory), `${path}/`)));
      continue;
    }

    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(path);
    }
  }

  return files;
}

/** ---- The copy: every office message exists, and the office block is the only one that grew. */
async function checkCopy(): Promise<void> {
  const required: readonly MessagePath[] = [
    "office.eyebrow",
    "office.workspaceTitle",
    "office.workspaceDescription",
    "office.rolesHeading",
    "office.dutiesHeading",
    "office.sectionsHeading",
    "office.navLabel",
    "office.approvalChain",
    "office.sectionWorkspace",
    "office.sectionWorkspaceDescription",
    "office.sectionSessions",
    "office.sectionSessionsDescription",
    "office.sectionTwoFactorResets",
    "office.sectionTwoFactorResetsDescription",
    "office.roleSuperAdmin",
    "office.roleCeo",
    "office.roleComplianceKyc",
    "office.roleFinanceOps",
    "office.roleSupport",
    "office.roleBlogger",
    "office.charterSuperAdmin",
    "office.charterCeo",
    "office.charterComplianceKyc",
    "office.charterFinanceOps",
    "office.charterSupport",
    "office.charterBlogger",
    "office.accessDeniedTitle",
    "office.accessDeniedBody",
    "office.unavailableTitle",
    "office.unavailableBody",
    "office.homeLink",
  ];

  for (const path of required) {
    const message = getMessage(path);

    expect(message.length > 0, `${path} is in the catalog`);
    expectEqual(message, message.trim(), `${path} is trimmed`);
    expectEqual(message.includes("{"), false, `${path} has no placeholder this screen would not fill`);
  }

  expectEqual(getMessage("office.navLabel"), "Office navigation", "the navigation landmark is named in words");
  expectEqual(getMessage("office.eyebrow"), "Platform office", "and the office names itself as the platform side");
}

async function main(): Promise<void> {
  checkRoles();
  checkCatalog();
  checkRoleFiltering();
  checkAccessDecision();
  checkWorkspaceView();
  await checkDestinations();
  await checkShellSource();
  await checkCopy();

  if (failures.length > 0) {
    process.stderr.write(`office gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `office gate passed: ${checks} checks, ${OFFICE_ROLES.length} office roles, ` +
      `${OFFICE_NAVIGATION.length} screens, ${PLATFORM_ROLES.length} roles decided\n`,
  );
}

await main();
