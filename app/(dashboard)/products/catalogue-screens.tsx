// path: app/(dashboard)/products/catalogue-screens.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import {
  getCatalogueEntry,
  type CatalogueSnapshot,
} from "@/services/products/catalogue";
import { CATALOGUE_PATHS, type CatalogueKind } from "@/services/products/catalogue-fields";
import { readOwnerActor } from "../onboarding/owner-actor";
import { CatalogueForm } from "./catalogue-form";

/**
 * The three screens of section 15's two catalogues.
 *
 * ## Why one module renders both
 *
 * A product screen and a service screen print the same six facts and differ in the two sentences that
 * name the catalogue. Two files would be two copies of the actor reader, the four refusals, the layout
 * and the `SessionKeeper`, and the second copy is where a page quietly stops asking the service for
 * permission. The kind therefore arrives as an argument, the paths are derived from it, and both route
 * segments are three lines of wiring.
 *
 * ## Why the refusals are kept apart
 *
 * Signed out, not an owner, the store unavailable, and the row simply not there are four different
 * facts. A page that printed "not found" for an outage would tell a merchant their product was deleted,
 * and a page that printed a form to a visitor with no session would invite a post with nothing behind
 * it. Each state is worded as itself, and none of them restates a role: the service decides who may
 * read, the page only words the answer.
 */

type ScreenState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-found" }
  | { readonly kind: "ready"; readonly entry: CatalogueSnapshot };

/** The catalog title, per kind. */
function catalogueTitle(kind: CatalogueKind): string {
  return getMessage(kind === "product" ? "catalogue.productsTitle" : "catalogue.servicesTitle");
}

/** The catalog description, per kind. */
function catalogueDescription(kind: CatalogueKind): string {
  return getMessage(
    kind === "product" ? "catalogue.productsDescription" : "catalogue.servicesDescription",
  );
}

const linkClasses =
  "w-fit rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

const primaryLinkClasses =
  "w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background focus-visible:ring-2 focus-visible:ring-primary";

function shell(children: ReactNode): ReactNode {
  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">{children}</div>
    </main>
  );
}

function refusalSentence(state: ScreenState): string {
  if (state.kind === "signed-out") {
    return getMessage("catalogue.signedOut");
  }

  if (state.kind === "forbidden") {
    return getMessage("catalogue.forbidden");
  }

  return state.kind === "not-found" ? getMessage("catalogue.notFound") : getMessage("catalogue.unavailable");
}

async function readEntry(kind: CatalogueKind, entryId: string): Promise<ScreenState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const entry = await getCatalogueEntry(
      { actor: actorState.actor, kind, entryId },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return { kind: "ready", entry };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out" };
    }

    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return { kind: "forbidden" };
    }

    if (error instanceof AppError && error.code === "RESOURCE_NOT_FOUND") {
      return { kind: "not-found" };
    }

    return { kind: "unavailable" };
  }
}

/** The hub of one catalogue: what it is, and the way to add the first entry. */
export function CatalogueHub({ kind }: { readonly kind: CatalogueKind }): ReactNode {
  const path = `/${CATALOGUE_PATHS[kind]}`;

  return shell(
    <>
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">{getMessage("catalogue.eyebrow")}</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{catalogueTitle(kind)}</h1>
        <p className="text-sm text-muted-foreground">{catalogueDescription(kind)}</p>
      </header>

      <nav className="flex flex-col gap-2 text-sm">
        <Link className={primaryLinkClasses} href={`${path}/new`}>
          {getMessage(kind === "product" ? "catalogue.productNewTitle" : "catalogue.serviceNewTitle")}
        </Link>
        <Link className={linkClasses} href={`/${CATALOGUE_PATHS[kind === "product" ? "service" : "product"]}`}>
          {kind === "product" ? getMessage("catalogue.backToServices") : getMessage("catalogue.backToProducts")}
        </Link>
        <Link className={linkClasses} href="/">
          {getMessage("catalogue.homeLink")}
        </Link>
      </nav>
    </>,
  );
}

/** The create screen of one catalogue. */
export function CatalogueCreateScreen({ kind }: { readonly kind: CatalogueKind }): ReactNode {
  return shell(
    <>
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">{getMessage("catalogue.eyebrow")}</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage(kind === "product" ? "catalogue.productNewTitle" : "catalogue.serviceNewTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {getMessage(
            kind === "product" ? "catalogue.productNewDescription" : "catalogue.serviceNewDescription",
          )}
        </p>
      </header>

      {/* The form carries its own way back, so this screen adds none: two identical links on one page
          read as two different destinations. */}
      <CatalogueForm
        creating
        initial={null}
        kind={kind}
        savePath={`/api/${CATALOGUE_PATHS[kind]}`}
      />
    </>,
  );
}

/** The edit screen of one catalogue, with the four refusals worded apart. */
export async function CatalogueEditScreen({
  kind,
  entryId,
}: {
  readonly kind: CatalogueKind;
  readonly entryId: string;
}): Promise<ReactNode> {
  const state = await readEntry(kind, entryId);
  const path = `/${CATALOGUE_PATHS[kind]}`;

  return shell(
    <>
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-muted-foreground">{getMessage("catalogue.eyebrow")}</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {getMessage(kind === "product" ? "catalogue.productEditTitle" : "catalogue.serviceEditTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">{getMessage("catalogue.editDescription")}</p>
      </header>

      {state.kind === "ready" ? (
        <CatalogueForm
          creating={false}
          initial={state.entry}
          kind={kind}
          savePath={`/api/${CATALOGUE_PATHS[kind]}/${state.entry.id}`}
        />
      ) : (
        <p className="text-sm text-destructive" role="alert">
          {refusalSentence(state)}
        </p>
      )}

      <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
        {state.kind === "signed-out" ? (
          <Link className={linkClasses} href="/signin">
            {getMessage("catalogue.signInLink")}
          </Link>
        ) : null}
        <Link className={linkClasses} href={path}>
          {getMessage(kind === "product" ? "catalogue.backToProducts" : "catalogue.backToServices")}
        </Link>
        <Link className={linkClasses} href="/">
          {getMessage("catalogue.homeLink")}
        </Link>
      </nav>
    </>,
  );
}

/** The page metadata of one catalogue screen. */
export function catalogueMetadata(kind: CatalogueKind, screen: "hub" | "new" | "edit"): Metadata {
  if (screen === "hub") {
    return { title: catalogueTitle(kind), description: catalogueDescription(kind) };
  }

  const title =
    screen === "new"
      ? kind === "product"
        ? getMessage("catalogue.productNewTitle")
        : getMessage("catalogue.serviceNewTitle")
      : kind === "product"
        ? getMessage("catalogue.productEditTitle")
        : getMessage("catalogue.serviceEditTitle");

  return { title, description: getMessage("catalogue.editDescription") };
}
