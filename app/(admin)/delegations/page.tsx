// path: app/(admin)/delegations/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import {
  PERMISSION_GROUPS,
  permissionGroupDescriptionKey,
  permissionGroupLabelKey,
  permissionLabelKey,
} from "@/lib/permissions/registry";
import { getPermissionRuntime, type PermissionRuntime } from "@/lib/permissions/runtime";
import { listDelegations, type DelegationSnapshot, type DelegationView } from "@/lib/permissions/service";
import { readOfficeActor } from "../office-actor";
import { DelegationConsole, type RevocableDelegation } from "./delegation-console";

export const metadata: Metadata = {
  title: getMessage("officeDelegations.title"),
  description: getMessage("officeDelegations.description"),
};

/**
 * The delegation screen of section 2: the one lever the super administrator has over the office.
 *
 * ## What the page answers
 *
 * Three questions, in the order an operator asks them: what is delegated right now and when does each
 * grant end, how do I hand one out or take one back, and what has already run out or been withdrawn.
 * The third is here because a screen that showed only live rows would hide the two ways a grant stops
 * being an authority - the clock and a colleague - and both are facts somebody has to be able to check.
 *
 * ## Why the page does not decide anything
 *
 * Every read goes through `lib/permissions/service.ts`, whose first statement is the role check, and the
 * grant form posts through the route, whose guards run before the body is parsed. So a page that was
 * ever rendered to the wrong account still cannot read the table, and a form that was edited still
 * cannot write a row without a fresh second factor.
 *
 * ## Two facts the page states rather than implies
 *
 * A delegation never changes a role - the holder keeps its charter and gains one action - and the three
 * permissions the super administrator keeps are named at the bottom instead of being silently absent
 * from the form. A person should never have to guess why a permission they know about is not offered.
 */
type DelegationState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly snapshot: DelegationSnapshot };

async function readDelegationState(runtime: PermissionRuntime): Promise<DelegationState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  try {
    return { kind: "ready", snapshot: await listDelegations({ actor: actorState.actor }, runtime) };
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

const sectionClasses = "flex flex-col gap-3 border-t border-border pt-6";

const headingClasses = "text-lg font-semibold tracking-tight";

const bodyClasses = "text-sm text-muted-foreground";

const listClasses = "flex flex-col gap-3";

const cardClasses =
  "flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const rowHeaderClasses = "flex flex-wrap items-center gap-x-3 gap-y-1";

const badgeClasses =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const definitionListClasses = "grid grid-cols-1 gap-1 text-sm sm:grid-cols-[12rem_1fr]";

const termClasses = "text-sm font-medium text-foreground";

const noteClasses =
  "mt-1 whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-3 text-sm";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

const alertClasses = "text-sm text-destructive";

/** One instant, printed the way every office screen prints one: UTC, minute precision. */
function formatInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** What a row names beside the permission: the person who holds it. */
function holderText(view: DelegationView): string {
  if (view.holderName === null && view.holderEmail === null) {
    return getMessage("officeDelegations.endedUnknown");
  }

  return view.holderName ?? (view.holderEmail ?? getMessage("officeDelegations.endedUnknown"));
}

function DelegationRow({ view }: { readonly view: DelegationView }): ReactNode {
  return (
    <li className={cardClasses}>
      <div className={rowHeaderClasses}>
        <span className={badgeClasses}>{getMessage(permissionLabelKey(view.permission))}</span>
        {view.expiringSoon ? (
          <span className={badgeClasses}>{getMessage("officeDelegations.expiringBadge")}</span>
        ) : null}
        {view.expired ? (
          <span className={badgeClasses}>{getMessage("officeDelegations.lapsedBadge")}</span>
        ) : null}
        <span className="text-sm font-semibold text-foreground">{holderText(view)}</span>
      </div>

      <dl className={definitionListClasses}>
        <dt className={bodyClasses}>{getMessage("officeDelegations.holderLabel")}</dt>
        <dd className="text-xs sm:text-sm">{view.holderEmail ?? getMessage("officeDelegations.endedUnknown")}</dd>
        <dt className={bodyClasses}>{getMessage("officeDelegations.grantedAtLabel")}</dt>
        <dd className="text-xs sm:text-sm">{formatInstant(view.grantedAtEpochMs)}</dd>
        <dt className={bodyClasses}>{getMessage("officeDelegations.grantedByLabel")}</dt>
        <dd className="text-xs sm:text-sm">{view.grantedByName ?? getMessage("officeDelegations.endedUnknown")}</dd>
        <dt className={bodyClasses}>{getMessage("officeDelegations.expiresAtLabel")}</dt>
        <dd className="text-xs sm:text-sm">
          {view.expiresAtEpochMs === null
            ? getMessage("officeDelegations.endedUnknown")
            : formatInstant(view.expiresAtEpochMs)}
        </dd>
        {view.revokedAtEpochMs === null ? null : (
          <>
            <dt className={bodyClasses}>{getMessage("officeDelegations.endedRevokedAtLabel")}</dt>
            <dd className="text-xs sm:text-sm">{formatInstant(view.revokedAtEpochMs)}</dd>
            <dt className={bodyClasses}>{getMessage("officeDelegations.endedRevokedByLabel")}</dt>
            <dd className="text-xs sm:text-sm">
              {view.revokedByName ?? getMessage("officeDelegations.endedUnknown")}
            </dd>
          </>
        )}
      </dl>

      {view.reason === null ? null : (
        <div>
          <p className={termClasses}>{getMessage("officeDelegations.reasonLabel")}</p>
          <p className={noteClasses}>{view.reason}</p>
        </div>
      )}
    </li>
  );
}

function DelegationList({
  rows,
  emptySentence,
}: {
  readonly rows: readonly DelegationView[];
  readonly emptySentence: string;
}): ReactNode {
  if (rows.length === 0) {
    return <p className={bodyClasses}>{emptySentence}</p>;
  }

  return (
    <ul className={listClasses}>
      {rows.map((view) => (
        <DelegationRow key={view.id} view={view} />
      ))}
    </ul>
  );
}

/** The option list the withdrawal select shows: the permission, then the person holding it. */
function revocableOf(snapshot: DelegationSnapshot): readonly RevocableDelegation[] {
  return snapshot.active.map((view) => ({
    id: view.id,
    label: `${getMessage(permissionLabelKey(view.permission))} - ${holderText(view)}`,
  }));
}

export default async function DelegationPage(): Promise<ReactNode> {
  const state = await readDelegationState(getPermissionRuntime());

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("officeDelegations.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("officeDelegations.title")}</h1>
        <p className={descriptionClasses}>{getMessage("officeDelegations.description")}</p>
      </header>

      {state.kind === "ready" ? (
        <>
          <section aria-labelledby="delegations-live" className={sectionClasses}>
            <h2 className={headingClasses} id="delegations-live">
              {getMessage("officeDelegations.liveHeading")}
            </h2>
            <p className={bodyClasses}>{getMessage("officeDelegations.liveDescription")}</p>
            <p className={bodyClasses}>
              {formatMessage("officeDelegations.liveCount", { count: state.snapshot.active.length })}{" "}
              {formatMessage("officeDelegations.expiringCount", {
                count: state.snapshot.active.filter((view) => view.expiringSoon).length,
              })}
            </p>
            <DelegationList
              emptySentence={getMessage("officeDelegations.liveEmpty")}
              rows={state.snapshot.active}
            />
          </section>

          <section aria-labelledby="delegations-grant" className={sectionClasses}>
            <h2 className={headingClasses} id="delegations-grant">
              {getMessage("officeDelegations.grantHeading")}
            </h2>
            <p className={bodyClasses}>{getMessage("officeDelegations.grantDescription")}</p>
            <dl className={definitionListClasses}>
              {PERMISSION_GROUPS.map((group) => (
                <div className="contents" key={group}>
                  <dt className={bodyClasses}>{getMessage(permissionGroupLabelKey(group))}</dt>
                  <dd className="text-xs text-muted-foreground sm:text-sm">
                    {getMessage(permissionGroupDescriptionKey(group))}
                  </dd>
                </div>
              ))}
            </dl>
            <DelegationConsole revocable={revocableOf(state.snapshot)} />
          </section>

          <section aria-labelledby="delegations-lapsed" className={sectionClasses}>
            <h2 className={headingClasses} id="delegations-lapsed">
              {getMessage("officeDelegations.lapsedHeading")}
            </h2>
            <p className={bodyClasses}>{getMessage("officeDelegations.lapsedDescription")}</p>
            <DelegationList
              emptySentence={getMessage("officeDelegations.lapsedEmpty")}
              rows={state.snapshot.lapsed}
            />
          </section>

          <section aria-labelledby="delegations-ended" className={sectionClasses}>
            <h2 className={headingClasses} id="delegations-ended">
              {getMessage("officeDelegations.endedHeading")}
            </h2>
            <p className={bodyClasses}>{getMessage("officeDelegations.endedDescription")}</p>
            <DelegationList
              emptySentence={getMessage("officeDelegations.endedEmpty")}
              rows={state.snapshot.ended}
            />
          </section>

          <section aria-labelledby="delegations-reserved" className={sectionClasses}>
            <h2 className={headingClasses} id="delegations-reserved">
              {getMessage("officeDelegations.reservedHeading")}
            </h2>
            <p className={bodyClasses}>{getMessage("officeDelegations.groupPlatformDescription")}</p>
            <ul className={listClasses}>
              {state.snapshot.reserved.map((permission) => (
                <li className={cardClasses} key={permission}>
                  <span className="text-sm font-semibold text-foreground">
                    {getMessage(permissionLabelKey(permission))}
                  </span>
                  <span className="text-xs text-muted-foreground sm:text-sm">{permission}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        <p className={alertClasses} role="alert">
          {state.kind === "signed-out"
            ? getMessage("officeDelegations.signedOut")
            : state.kind === "forbidden"
              ? getMessage("officeDelegations.forbidden")
              : getMessage("officeDelegations.unavailable")}
        </p>
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link className={linkClasses} href="/admin">
          {getMessage("officeDelegations.home")}
        </Link>
      </nav>
    </div>
  );
}
