// path: app/(admin)/dashboard/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { OfficeAccessPanel } from "@/components/office/office-access-panel";
import {
  decideOfficeAccess,
  officeAccessRedirect,
  officeSectionsFor,
  type OfficeSection,
} from "@/components/office/navigation";
import { AppError } from "@/lib/errors/app-error";
import { readStepUpState } from "@/lib/auth/step-up";
import { OFFICE_DASHBOARD_ROLES } from "@/lib/gateways/registry";
import { getGatewayRuntime, type GatewayRuntime } from "@/lib/gateways/runtime";
import { listGateways, type GatewaySnapshot } from "@/lib/gateways/service";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { readOfficeActor } from "../office-actor";

export const metadata: Metadata = {
  title: getMessage("officeDashboard.title"),
  description: getMessage("officeDashboard.description"),
};

/**
 * The super administrator's home: where the platform stands, and what only this role can change.
 *
 * ## Why this screen exists before the other dashboards
 *
 * Section 2 gives every office role a dashboard, and section 6 gives the super administrator the
 * gateway page. STEP 068 built the frame and left `/admin` as the workspace index; a person with the
 * super administrator role is left with a frame and a list of links, and the one thing only they can
 * act on - which gateways are on - lives one click away with no summary in front of it. This page is
 * that summary, in the same order a person needs it: who I am here, how fresh my proof is, what the
 * gateways are doing, and where else I may go.
 *
 * ## The second factor, shown and not assumed
 *
 * Section 6 requires fresh reauthentication before a gateway changes, and STEP 053 defines fresh as
 * proven within ten minutes. The dashboard states where the session stands - proven at, valid until,
 * or stale - so an operator discovers the requirement before pressing a button rather than from a
 * refusal. The window is read with the same pure function the service enforces, so the two cannot
 * disagree about what "fresh" means.
 *
 * ## Two reads, two failures
 *
 * The account is the layout's cached read. The gateway summary is a permission of its own, so it is
 * read here with the service that owns the role check, and a catalogue that cannot be read becomes a
 * sentence rather than an error screen: the rest of the page is still true without it.
 */
const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const sectionClasses = "flex flex-col gap-3 border-t border-border pt-6";

const headingClasses = "text-lg font-semibold tracking-tight";

const termClasses = "text-sm font-medium text-foreground";

const bodyClasses = "text-sm text-muted-foreground";

const cardClasses =
  "flex flex-col gap-1 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const cardLinkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

const cardListClasses = "grid gap-3 sm:grid-cols-2";

const chainClasses = "rounded-lg border border-border bg-muted p-4 text-sm text-muted-foreground";

const alertClasses = "text-sm text-destructive";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

/** One instant, printed the way every office screen prints one: UTC, minute precision. */
function formatInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

async function readGatewaySummary(runtime: GatewayRuntime): Promise<GatewaySnapshot | null> {
  const actorState = await readOfficeActor();

  if (actorState.kind !== "actor") {
    return null;
  }

  try {
    return await listGateways({ actor: actorState.actor }, runtime);
  } catch (error) {
    if (error instanceof AppError) {
      return null;
    }

    throw error;
  }
}

function ScreensList({ sections }: { readonly sections: readonly OfficeSection[] }): ReactNode {
  return (
    <ul className={cardListClasses}>
      {sections.map((section) => (
        <li className={cardClasses} key={section.key}>
          <Link className={cardLinkClasses} href={section.href}>
            {getMessage(section.labelKey)}
          </Link>
          <p className={bodyClasses}>{getMessage(section.descriptionKey)}</p>
        </li>
      ))}
    </ul>
  );
}

export default async function OfficeDashboardPage(): Promise<ReactNode> {
  const access = decideOfficeAccess(await readOfficeActor());
  const destination = officeAccessRedirect(access);

  if (destination !== null) {
    redirect(destination);
  }

  if (access.kind !== "allowed") {
    return <OfficeAccessPanel kind={access.kind === "denied" ? "denied" : "unavailable"} />;
  }

  // Section 6's page is the super administrator's, and this home summarises it, so every other office
  // role is told that here rather than shown counts it cannot act on.
  if (!access.roles.some((role) => OFFICE_DASHBOARD_ROLES.includes(role))) {
    return <OfficeAccessPanel kind="denied" />;
  }

  const sections = officeSectionsFor(access.roles);
  const runtime = getGatewayRuntime();
  const gateways = await readGatewaySummary(runtime);
  const actorState = await readOfficeActor();
  // The instant comes from the dependency the service already uses, so the freshness this page
  // prints and the freshness a mutation enforces are read from the same clock and the same window.
  const stepUp =
    actorState.kind === "actor" ? readStepUpState(actorState.actor, runtime.now()) : null;

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("officeDashboard.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("officeDashboard.title")}</h1>
        <p className={descriptionClasses}>{getMessage("officeDashboard.description")}</p>
      </header>

      <section aria-labelledby="office-dashboard-access" className={sectionClasses}>
        <h2 className={headingClasses} id="office-dashboard-access">
          {getMessage("officeDashboard.accessHeading")}
        </h2>
        <dl className="flex flex-col gap-2">
          <div>
            <dt className={termClasses}>{getMessage("officeDashboard.rolesLabel")}</dt>
            <dd className={bodyClasses}>{access.roles.join(", ")}</dd>
          </div>
          <div>
            <dt className={termClasses}>{getMessage("officeDashboard.secondFactorLabel")}</dt>
            <dd className={bodyClasses}>
              {stepUp !== null &&
              stepUp.satisfied &&
              stepUp.provenAtEpochMs !== null &&
              stepUp.freshUntilEpochMs !== null
                ? formatMessage("officeDashboard.secondFactorFresh", {
                    at: formatInstant(stepUp.provenAtEpochMs),
                    until: formatInstant(stepUp.freshUntilEpochMs),
                  })
                : getMessage("officeDashboard.secondFactorStale")}
            </dd>
          </div>
        </dl>
        <Link className={linkClasses} href="/reauth">
          {getMessage("officeDashboard.reauthLink")}
        </Link>
      </section>

      <section aria-labelledby="office-dashboard-gateways" className={sectionClasses}>
        <h2 className={headingClasses} id="office-dashboard-gateways">
          {getMessage("officeDashboard.gatewaysHeading")}
        </h2>
        {gateways === null ? (
          <p className={alertClasses} role="alert">
            {getMessage("officeDashboard.gatewaysUnavailable")}
          </p>
        ) : (
          <>
            <p className={bodyClasses}>
              {formatMessage("officeDashboard.gatewaysSummary", {
                total: gateways.gateways.length,
                enabled: gateways.enabledCount,
                untested: gateways.untestedCount,
                adapterless: gateways.adapterlessCount,
              })}
            </p>
            <Link className={linkClasses} href="/gateways">
              {getMessage("officeDashboard.gatewaysLink")}
            </Link>
          </>
        )}
      </section>

      <section aria-labelledby="office-dashboard-screens" className={sectionClasses}>
        <h2 className={headingClasses} id="office-dashboard-screens">
          {getMessage("officeDashboard.screensHeading")}
        </h2>
        <p className={bodyClasses}>{getMessage("officeDashboard.screensDescription")}</p>
        <ScreensList sections={sections} />
      </section>

      <section aria-labelledby="office-dashboard-approval" className={sectionClasses}>
        <h2 className={headingClasses} id="office-dashboard-approval">
          {getMessage("officeDashboard.approvalHeading")}
        </h2>
        <p className={chainClasses}>{getMessage("office.approvalChain")}</p>
      </section>

      <Link className={linkClasses} href="/admin">
        {getMessage("officeDashboard.home")}
      </Link>
    </div>
  );
}
