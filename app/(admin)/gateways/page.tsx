// path: app/(admin)/gateways/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { getGatewayRuntime } from "@/lib/gateways/runtime";
import { listGateways, type GatewaySnapshot } from "@/lib/gateways/service";
import { getMessage } from "@/lib/i18n/messages";
import { readOfficeActor } from "../office-actor";
import { GatewayConsole } from "./gateway-console";

export const metadata: Metadata = {
  title: getMessage("officeGateways.title"),
  description: getMessage("officeGateways.description"),
};

/**
 * Section 6's gateway page: the five providers, their keys, and the two switches.
 *
 * ## Why the screen reads through the service and not the table
 *
 * `listGateways` owns the role check, the column list and the registry join. A page that built its
 * own query would be a second place that decides which columns a browser may see, and the columns
 * this table holds are the ones that must never reach a browser: `key_ciphertext`, `key_iv` and
 * `key_tag` are simply not in the select, so no screen can leak what it never received.
 *
 * ## The five answers
 *
 * "Nobody is signed in", "this account may not manage gateways", "the catalogue could not be read",
 * "an account could not be read at all" and the catalogue itself are five different facts, and four of
 * them are sentences rather than an empty list. The layout above has already refused an account
 * without an office role; this page asks the same question again through the one role constant the
 * service uses, so it refuses in the same way if it were ever rendered outside the group.
 */
type GatewaysState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly snapshot: GatewaySnapshot };

async function readGatewaysState(): Promise<GatewaysState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  try {
    const snapshot = await listGateways({ actor: actorState.actor }, getGatewayRuntime());

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

const homeLinkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

export default async function GatewaysPage(): Promise<ReactNode> {
  const state = await readGatewaysState();

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("officeGateways.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("officeGateways.title")}</h1>
        <p className={descriptionClasses}>{getMessage("officeGateways.description")}</p>
      </header>

      {state.kind === "ready" ? (
        <GatewayConsole gateways={state.snapshot.gateways} />
      ) : (
        <p className="text-sm text-destructive" role="alert">
          {state.kind === "signed-out"
            ? getMessage("officeGateways.signedOut")
            : state.kind === "forbidden"
              ? getMessage("officeGateways.forbidden")
              : getMessage("officeGateways.unavailable")}
        </p>
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link className={homeLinkClasses} href="/admin">
          {getMessage("officeGateways.home")}
        </Link>
      </nav>
    </div>
  );
}
