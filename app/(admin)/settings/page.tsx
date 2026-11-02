// path: app/(admin)/settings/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import {
  readComplianceCalendar,
  readPlatformInformation,
  type ComplianceCalendarSnapshot,
  type PlatformInformationSnapshot,
} from "@/lib/settings/service";
import {
  COMPLIANCE_CALENDAR_READ_ROLES,
  PLATFORM_INFORMATION_ROLES,
} from "@/lib/settings/registry";
import { getSettingsRuntime } from "@/lib/settings/runtime";
import { getMessage } from "@/lib/i18n/messages";
import { readOfficeActor } from "../office-actor";
import { ComplianceCalendarConsole } from "./compliance-calendar-console";
import { PlatformSettingsForm } from "./platform-settings-form";

export const metadata: Metadata = {
  title: getMessage("officeSettings.title"),
  description: getMessage("officeSettings.description"),
};

/**
 * Section 24's general settings and section 3's compliance calendar on one screen.
 *
 * ## Why one screen and two sections
 *
 * The feature list puts them together: section 24 gives the super administrator "the platform logo and
 * all platform information from settings", and section 3 keeps the appointed compliance officer - a
 * platform setting - beside the calendar of certificates whose expiry must not be missed. They are one
 * screen because they are one question: who the platform is, and what it must prove about itself.
 *
 * ## Why each section has its own answer
 *
 * The roles differ. The platform information is the super administrator's alone (`0080`'s policy says
 * so and `PLATFORM_INFORMATION_ROLES` agrees); the calendar is the compliance desk's to work, the
 * CEO's to read and the super administrator's by section 2 (`0099` wrote the policy that makes that
 * true in the database). A page that refused the whole screen on the stricter rule would hide the
 * calendar from the desk that files it, so each half is read under its own rule and rendered when it
 * answers.
 *
 * ## The five answers
 *
 * "Nobody is signed in", "this account opens neither half", "the settings could not be read", "the
 * calendar could not be read" and the two sections are all different facts. The layout above has
 * already refused an account without an office role; this page answers for the two halves it owns.
 */
interface SettingsState {
  readonly kind: "signed-out" | "forbidden" | "unavailable" | "ready";
  readonly settings: PlatformInformationSnapshot | null;
  readonly calendar: ComplianceCalendarSnapshot | null;
}

const emptyState = (
  kind: SettingsState["kind"],
  settings: PlatformInformationSnapshot | null,
  calendar: ComplianceCalendarSnapshot | null,
): SettingsState => ({ kind, settings, calendar });

/** True when the actor holds one of these roles. A section is read only where it may be. */
function holds(roles: readonly string[], allowed: readonly string[]): boolean {
  return roles.some((role) => allowed.includes(role));
}

async function readSettingsState(): Promise<SettingsState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return emptyState("signed-out", null, null);
  }

  if (actorState.kind !== "actor") {
    return emptyState("unavailable", null, null);
  }

  const actor = actorState.actor;
  const runtime = getSettingsRuntime();
  let settings: PlatformInformationSnapshot | null = null;
  let calendar: ComplianceCalendarSnapshot | null = null;
  let signedOut = false;
  let unavailable = false;

  if (holds(actor.roles, PLATFORM_INFORMATION_ROLES)) {
    try {
      settings = await readPlatformInformation({ actor }, runtime);
    } catch (error) {
      if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
        signedOut = true;
      } else if (!(error instanceof AppError && error.code === "PERMISSION_DENIED")) {
        unavailable = true;
      }
    }
  }

  if (holds(actor.roles, COMPLIANCE_CALENDAR_READ_ROLES)) {
    try {
      calendar = await readComplianceCalendar({ actor }, runtime);
    } catch (error) {
      if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
        signedOut = true;
      } else if (!(error instanceof AppError && error.code === "PERMISSION_DENIED")) {
        unavailable = true;
      }
    }
  }

  if (signedOut) {
    return emptyState("signed-out", null, null);
  }

  if (settings === null && calendar === null) {
    return emptyState(unavailable ? "unavailable" : "forbidden", null, null);
  }

  return emptyState("ready", settings, calendar);
}

const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const sectionClasses = "flex flex-col gap-3";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const headingClasses = "text-xl font-semibold tracking-tight";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const alertClasses = "text-sm text-destructive";

const homeLinkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

export default async function SettingsPage(): Promise<ReactNode> {
  const state = await readSettingsState();

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("officeSettings.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("officeSettings.title")}</h1>
        <p className={descriptionClasses}>{getMessage("officeSettings.description")}</p>
      </header>

      {state.kind !== "ready" ? (
        <p className={alertClasses} role="alert">
          {state.kind === "signed-out"
            ? getMessage("officeSettings.signedOut")
            : state.kind === "forbidden"
              ? getMessage("officeSettings.forbidden")
              : getMessage("officeSettings.unavailable")}
        </p>
      ) : null}

      {state.settings === null ? null : (
        <section aria-labelledby="settings-platform" className={sectionClasses}>
          <h2 className={headingClasses} id="settings-platform">
            {getMessage("officeSettings.settingsHeading")}
          </h2>
          <p className={descriptionClasses}>{getMessage("officeSettings.settingsDescription")}</p>
          <PlatformSettingsForm snapshot={state.settings} />
        </section>
      )}

      {state.calendar === null ? null : (
        <section aria-labelledby="settings-calendar" className={sectionClasses}>
          <h2 className={headingClasses} id="settings-calendar">
            {getMessage("officeSettings.calendarHeading")}
          </h2>
          <p className={descriptionClasses}>{getMessage("officeSettings.calendarDescription")}</p>
          <ComplianceCalendarConsole snapshot={state.calendar} />
        </section>
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link className={homeLinkClasses} href="/admin">
          {getMessage("officeSettings.home")}
        </Link>
      </nav>
    </div>
  );
}
