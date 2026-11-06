// path: app/(admin)/provisioning-alerts/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { listProvisioningQueue } from "@/services/submerchant/provisioning-queue";
import { readOfficeActor } from "../office-actor";
import { ProvisioningConsole } from "./provisioning-console";

export const metadata: Metadata = {
  title: getMessage("officeProvisioning.title"),
  description: getMessage("officeProvisioning.description"),
};

/**
 * Section 5's provisioning alert: the office end of `0054`'s queue.
 *
 * ## What this page is, and what it is not
 *
 * The rows are written by `enqueueProvisioningAfterApproval` of STEP 095, the role list and the act are
 * this STEP's `listProvisioningQueue` and `acknowledgeProvisioningAlert`, and the wording of the whole
 * platform is the catalog. The page is the two lists a person works from - the provisions that are
 * blocked because no master platform account is connected, and the ones in flight that are waiting on a
 * provider - and one control on each blocked row.
 *
 * ## Why the refusal is the service's answer
 *
 * There is no role list in this file. `listProvisioningQueue` asks `PROVISIONING_ALERT_OFFICE_ROLES` and
 * the second factor question before its first query, with the same two functions the acknowledgement
 * itself uses, so a role that could not acknowledge a row cannot read the queue either - and this screen
 * cannot offer an action its service would refuse. The three refusals are told apart because they mean
 * different things: no session is the sign in form, a role without the permission is an answer, and a
 * read that did not happen is an outage that must not look like an empty queue.
 *
 * ## Why the day and the clock are the platform's
 *
 * Every instant printed here is a `timestamptz` from the platform's database, printed in UTC with the
 * seconds cut. Two officers reading the same row must be reading one fact, and "how long has this been
 * waiting" is computed by the service from the same clock that printed the page.
 */

type ProvisioningStateKind = "signed-out" | "forbidden" | "unavailable" | "ready";

interface ProvisioningState {
  readonly kind: ProvisioningStateKind;
  readonly queue: Awaited<ReturnType<typeof listProvisioningQueue>> | null;
}

async function readProvisioningState(): Promise<ProvisioningState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out", queue: null };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable", queue: null };
  }

  const runtime = getAuthRuntime();

  try {
    const queue = await listProvisioningQueue(
      { actor: actorState.actor },
      { rest: runtime.rest, audit: runtime.audit, now: (): number => Date.now() },
    );

    return { kind: "ready", queue };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out", queue: null };
    }

    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return { kind: "forbidden", queue: null };
    }

    return { kind: "unavailable", queue: null };
  }
}

const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const noteClasses = "max-w-3xl text-xs text-muted-foreground";

const alertClasses = "text-sm text-destructive";

const metaClasses = "flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

/** One instant, printed the way every office screen prints one: UTC, seconds cut. */
function instantOf(iso: string): string {
  const parsed = Date.parse(iso);

  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().replace("T", " ").slice(0, 19)
    : iso;
}

export default async function ProvisioningAlertsPage(): Promise<ReactNode> {
  const state = await readProvisioningState();
  const queue = state.queue;

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("officeProvisioning.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("officeProvisioning.title")}</h1>
        <p className={descriptionClasses}>{getMessage("officeProvisioning.description")}</p>
        <p className={noteClasses}>{getMessage("officeProvisioning.guardNote")}</p>
      </header>

      {queue === null ? (
        <p className={alertClasses} role="alert">
          {state.kind === "signed-out"
            ? getMessage("officeProvisioning.signedOut")
            : state.kind === "forbidden"
              ? getMessage("officeProvisioning.forbidden")
              : getMessage("officeProvisioning.unavailable")}
        </p>
      ) : (
        <>
          <p className={metaClasses}>
            <span>{formatMessage("officeProvisioning.blockedCount", { count: queue.blockedCount })}</span>
            {queue.overdueCount > 0 ? (
              <span>{formatMessage("officeProvisioning.overdueCount", { count: queue.overdueCount })}</span>
            ) : null}
            <span>{formatMessage("officeProvisioning.inFlightCount", { count: queue.inFlightCount })}</span>
            <span>
              {formatMessage("officeProvisioning.readAt", {
                at: instantOf(new Date().toISOString()),
              })}
            </span>
          </p>

          {queue.truncated ? (
            <p className={noteClasses}>
              {formatMessage("officeProvisioning.truncatedNote", { limit: queue.limit })}
            </p>
          ) : null}

          <ProvisioningConsole queue={queue} />
        </>
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link className={linkClasses} href="/admin">
          {getMessage("officeProvisioning.home")}
        </Link>
      </nav>
    </div>
  );
}
