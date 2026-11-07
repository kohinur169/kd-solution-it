// path: app/(admin)/plans/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import { BILLING_PLAN_ROLES } from "../../../services/billing/plans-registry";
import { listPlans, type PlanCatalogue } from "../../../services/billing/plans";
import { getPlanRuntime } from "../../../services/billing/plans-runtime";
import { readOfficeActor } from "../office-actor";
import { PlansConsole } from "./plans-console";

export const metadata: Metadata = {
  title: getMessage("officePlans.title"),
  description: getMessage("officePlans.description"),
};

/**
 * Section 9's plan catalogue, for the one role that writes it.
 *
 * ## Why the screen reads through the service and not the tables
 *
 * `listPlans` owns the role, the column list, the two reads that make a plan and its services, and
 * the order the catalogue is shown in. A page that built its own query would be a second place that
 * decides what the catalogue is - and the second place is where the screen and the route would start
 * to disagree about which plans exist.
 *
 * ## The four answers
 *
 * "Nobody is signed in", "this account does not create plans", "the catalogue could not be read" and
 * the catalogue itself are four different facts, and three of them are sentences rather than an empty
 * list. The layout above has already refused an account without an office role; this page asks the
 * catalogue's own question again, so it refuses in the same way if it were ever rendered outside the
 * group.
 */
type PlansState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly catalogue: PlanCatalogue };

async function readPlansState(): Promise<PlansState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const actor = actorState.actor;

  if (!BILLING_PLAN_ROLES.some((role) => actor.roles.includes(role))) {
    return { kind: "forbidden" };
  }

  try {
    const catalogue = await listPlans({ actor }, getPlanRuntime());

    return { kind: "ready", catalogue };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out" };
    }

    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return { kind: "forbidden" };
    }

    return { kind: "unavailable" };
  }
}

const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const alertClasses = "text-sm text-destructive";

const homeLinkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

export default async function PlansPage(): Promise<ReactNode> {
  const state = await readPlansState();

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("officePlans.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("officePlans.title")}</h1>
        <p className={descriptionClasses}>{getMessage("officePlans.description")}</p>
      </header>

      {state.kind === "ready" ? (
        <PlansConsole catalogue={state.catalogue} />
      ) : (
        <p className={alertClasses} role="alert">
          {state.kind === "signed-out"
            ? getMessage("officePlans.signedOut")
            : state.kind === "forbidden"
              ? getMessage("officePlans.forbidden")
              : getMessage("officePlans.unavailable")}
        </p>
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link className={homeLinkClasses} href="/admin">
          {getMessage("officePlans.home")}
        </Link>
      </nav>
    </div>
  );
}
