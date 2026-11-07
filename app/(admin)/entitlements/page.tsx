// path: app/(admin)/entitlements/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { ENTITLEMENT_READ_ROLES, MERCHANT_FEATURES } from "../../../services/billing/entitlements";
import { readOfficeActor } from "../office-actor";
import { EntitlementsConsole } from "./entitlements-console";

export const metadata: Metadata = {
  title: getMessage("officeEntitlements.title"),
  description: getMessage("officeEntitlements.description"),
};

/**
 * Section 9's entitlements, as the office sees them: one merchant, their plan, and which services it grants.
 *
 * ## Why the screen starts with a merchant's id
 *
 * The plan a merchant is on is STEP 214's write and the services a plan includes are STEP 212's; neither
 * belongs here. What this STEP adds is the *reading* of the two together, so the screen asks for the one
 * thing it cannot know and renders the six verdicts that follow. A list of every merchant would need a
 * merchant directory this STEP does not own, and a guessed default would show a super administrator somebody
 * else's plan while looking like an overview.
 *
 * ## Why the role is checked twice
 *
 * The office layout already refuses an account without an office role, and the route refuses one without
 * `super_admin` beside the read it guards. This page checks the same list again so that an account which
 * may enter the office but may not read a merchant's entitlement sees the sentence for it rather than an
 * empty console - the same three-fact answer the plans screen gives.
 */
type EntitlementsState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "ready" };

function stateOf(actorState: Awaited<ReturnType<typeof readOfficeActor>>): EntitlementsState {
  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "signed-out" };
  }

  const actor = actorState.actor;

  return ENTITLEMENT_READ_ROLES.some((role) => actor.roles.includes(role))
    ? { kind: "ready" }
    : { kind: "forbidden" };
}

const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const alertClasses = "text-sm text-destructive";

const homeLinkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

export default async function EntitlementsPage(): Promise<ReactNode> {
  const state = stateOf(await readOfficeActor());

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("officeEntitlements.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("officeEntitlements.title")}</h1>
        <p className={descriptionClasses}>{getMessage("officeEntitlements.description")}</p>
      </header>

      {state.kind === "ready" ? (
        <EntitlementsConsole features={MERCHANT_FEATURES.map((feature) => ({ key: feature.key, labelKey: feature.labelKey }))} />
      ) : (
        <p className={alertClasses} role="alert">
          {state.kind === "signed-out"
            ? getMessage("officeEntitlements.signedOut")
            : getMessage("officeEntitlements.forbidden")}
        </p>
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link className={homeLinkClasses} href="/admin">
          {getMessage("officeEntitlements.home")}
        </Link>
      </nav>
    </div>
  );
}
