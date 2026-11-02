// path: app/(admin)/countries/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { getCountryRuntime } from "@/lib/countries/runtime";
import { listCountrySwitches, type CountrySwitchSnapshot } from "@/lib/countries/service";
import { getMessage } from "@/lib/i18n/messages";
import { readOfficeActor } from "../office-actor";
import { CountrySwitchConsole } from "./country-switch-console";

export const metadata: Metadata = {
  title: getMessage("officeCountries.title"),
  description: getMessage("officeCountries.description"),
};

/**
 * Section 3's country switch: every country the platform knows, and the two turns on each.
 *
 * ## Why the screen reads through the service and not the table
 *
 * `listCountrySwitches` owns the two roles, the column list and the join with the approval chain. A
 * page that built its own query would be a second place that decides what a browser may see, and it
 * would have to re-derive which decision stands behind which country - the one thing this screen
 * exists to show honestly.
 *
 * ## The four answers
 *
 * "Nobody is signed in", "this account does not control the switch", "the list could not be read" and
 * the list itself are four different facts, and three of them are sentences rather than an empty
 * list. The layout above has already refused an account without an office role; this page asks the
 * switch's own question again, so it refuses in the same way if it were ever rendered outside the
 * group.
 */
type CountriesState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly snapshot: CountrySwitchSnapshot };

async function readCountriesState(): Promise<CountriesState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  try {
    const snapshot = await listCountrySwitches({ actor: actorState.actor }, getCountryRuntime());

    return { kind: "ready", snapshot };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === "AUTHENTICATION_REQUIRED") {
        return { kind: "signed-out" };
      }

      if (error.code === "PERMISSION_DENIED") {
        return { kind: "forbidden" };
      }
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

export default async function CountriesPage(): Promise<ReactNode> {
  const state = await readCountriesState();

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("officeCountries.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("officeCountries.title")}</h1>
        <p className={descriptionClasses}>{getMessage("officeCountries.description")}</p>
      </header>

      {state.kind === "ready" ? (
        <CountrySwitchConsole snapshot={state.snapshot} />
      ) : (
        <p className={alertClasses} role="alert">
          {state.kind === "signed-out"
            ? getMessage("officeCountries.signedOut")
            : state.kind === "forbidden"
              ? getMessage("officeCountries.forbidden")
              : getMessage("officeCountries.unavailable")}
        </p>
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link className={homeLinkClasses} href="/admin">
          {getMessage("officeCountries.home")}
        </Link>
      </nav>
    </div>
  );
}
