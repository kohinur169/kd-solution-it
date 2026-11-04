// path: app/(dashboard)/products/catalogue-import-screen.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { MAXIMUM_CSV_ROWS } from "@/services/clients/csv";
import {
  CATALOGUE_DEFAULT_UNIT,
  CATALOGUE_PATHS,
  CATALOGUE_UNITS,
  type CatalogueKind,
} from "@/services/products/catalogue-fields";
import { CATALOGUE_IMPORT_MAXIMUM_ROWS } from "@/services/products/catalogue-import";
import { readOwnerActor } from "../onboarding/owner-actor";
import { CatalogueImportForm } from "./catalogue-import-form";

/**
 * Section 15's catalogue CSV import, as a screen.
 *
 * ## Why the page reads the account and the form does not
 *
 * The form is a client component: it posts a file and prints the answer. Whether there is a session at
 * all is a server question, and a merchant who arrives here signed out should be told so instead of being
 * shown a file picker that will be refused. The page therefore reads the account once, exactly as the
 * catalogue list and the catalogue form do, and words the same refusals the same way.
 *
 * ## Why the limits are printed
 *
 * A merchant with a five thousand row export needs to know before they upload it that this import takes a
 * thousand at a time, and a merchant whose spreadsheet calls the unit something unusual needs to know
 * which headers are read and what a blank unit means. Both facts are the service's own constants - the
 * row ceiling, the unit vocabulary and the catalogue's default unit - so the sentence cannot drift from
 * the code that enforces it.
 */

const linkClasses =
  "w-fit rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

/** The title of one catalogue's import screen. */
function titleOf(kind: CatalogueKind): string {
  return getMessage(
    kind === "product" ? "catalogue.importTitleProducts" : "catalogue.importTitleServices",
  );
}

/** The page metadata of one catalogue's import screen. */
export function catalogueImportMetadata(kind: CatalogueKind): Metadata {
  return { title: titleOf(kind), description: getMessage("catalogue.importDescription") };
}

export async function CatalogueImportScreen({
  kind,
}: {
  readonly kind: CatalogueKind;
}): Promise<ReactNode> {
  const actorState = await readOwnerActor();
  const listPath = `/${CATALOGUE_PATHS[kind]}`;

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">{getMessage("catalogue.eyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{titleOf(kind)}</h1>
          <p className="text-sm text-muted-foreground">{getMessage("catalogue.importDescription")}</p>
        </header>

        {actorState.kind === "actor" ? (
          <>
            <p className="text-xs text-muted-foreground">
              {formatMessage("catalogue.importLimits", {
                rows: CATALOGUE_IMPORT_MAXIMUM_ROWS,
                records: MAXIMUM_CSV_ROWS,
                units: CATALOGUE_UNITS.join(", "),
                defaultUnit: CATALOGUE_DEFAULT_UNIT[kind],
              })}
            </p>
            <CatalogueImportForm kind={kind} />
          </>
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {actorState.kind === "anonymous"
              ? getMessage("catalogue.importSignedOut")
              : getMessage("catalogue.importUnavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {actorState.kind === "anonymous" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("catalogue.signInLink")}
            </Link>
          ) : null}
          <Link className={linkClasses} href={listPath}>
            {getMessage(
              kind === "product" ? "catalogue.importBackToProducts" : "catalogue.importBackToServices",
            )}
          </Link>
          <Link className={linkClasses} href="/">
            {getMessage("catalogue.homeLink")}
          </Link>
        </nav>
      </div>
    </main>
  );
}
