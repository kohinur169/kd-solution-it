// path: app/(dashboard)/onboarding/review/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import type { BusinessAddressField } from "@/services/kyc/business-address-fields";
import type { BusinessProfileField } from "@/services/kyc/processor-fields";
import { BUSINESS_ADDRESS_FIELDS } from "@/services/kyc/business-address-fields";
import { BUSINESS_PROFILE_FIELDS } from "@/services/kyc/processor-fields";
import {
  readProcessorProfile,
  type ProcessorProfileSnapshot,
} from "@/services/submerchant/processor-profile";
import { readOwnerActor } from "../owner-actor";

export const metadata: Metadata = {
  title: getMessage("onboardingReview.title"),
  description: getMessage("onboardingReview.description"),
};

/** The profile is read per request, so a save made in another tab shows on the next load. */
export const dynamic = "force-dynamic";

/**
 * The review step of section 5: the one profile, shown the way the processors will receive it.
 *
 * ## What it is
 *
 * Section 5 says the merchant sets their business information once and the same information is
 * sent to every connected processor. STEPs 080-082 stored those facts on the one
 * `business_profiles` row, and `services/submerchant/processor-profile.ts` reads that row once and
 * assembles the payload per processor. This page is the merchant's view of that assembly: the
 * business, the category, the address and the contact person, and beside them what each of the
 * five processors is sent and what is still missing.
 *
 * ## Why it is read-only
 *
 * The review step checks the profile, it does not edit it: every field here belongs to the form of
 * the step that owns it (the wizard links there through `ONBOARDING_STEP_FORMS`), so this page
 * renders values and never an input. That is also why it needs no client component: the whole
 * page is server-rendered from one service read, and the session keeper is the only browser piece.
 *
 * ## Why the four answers are kept apart
 *
 * Same as the other step pages: a session that ended, an account that is not an owner, an outage
 * and a profile that has simply not been filled yet are four different facts, and each is worded
 * as itself.
 */
type ReviewPageState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly snapshot: ProcessorProfileSnapshot };

async function readReviewState(): Promise<ReviewPageState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const snapshot = await readProcessorProfile(
      { actor: actorState.actor },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return { kind: "ready", snapshot };
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

/** The catalog label of one business field, so the review reads like the form that filled it. */
const BUSINESS_LABELS: Readonly<Record<BusinessProfileField, MessagePath>> = Object.freeze({
  legal_name: "onboardingBusiness.legalName",
  trading_name: "onboardingBusiness.tradingName",
  business_type: "onboardingBusiness.businessType",
  registration_number: "onboardingBusiness.registrationNumber",
  tax_id: "onboardingBusiness.taxId",
  website: "onboardingBusiness.website",
  business_description: "onboardingBusiness.businessDescription",
});

/** The catalog label of one address or contact field. */
const ADDRESS_LABELS: Readonly<Record<BusinessAddressField, MessagePath>> = Object.freeze({
  address_line1: "onboardingAddress.addressLine1",
  address_line2: "onboardingAddress.addressLine2",
  city: "onboardingAddress.city",
  state_province: "onboardingAddress.stateProvince",
  postal_code: "onboardingAddress.postalCode",
  country_code: "onboardingAddress.countryCode",
  contact_name: "onboardingAddress.contactName",
  contact_email: "onboardingAddress.contactEmail",
  contact_phone: "onboardingAddress.contactPhone",
});

/** The words a missing fact is shown with, per section prefix of `blocking`. */
function blockingLabel(entry: string): string {
  if (entry.startsWith("business.")) {
    const field = entry.slice("business.".length) as BusinessProfileField;

    return getMessage(BUSINESS_LABELS[field]);
  }

  if (entry === "category.mcc_code") {
    return getMessage("onboardingCategory.codeLabel");
  }

  const field = entry.slice("address.".length) as BusinessAddressField;

  return getMessage(ADDRESS_LABELS[field]);
}

/** The value of one business field, with the business type shown as its catalog word. */
function businessValue(field: BusinessProfileField, value: string | null): string {
  if (value === null) {
    return getMessage("onboardingReview.fieldMissing");
  }

  if (field === "business_type") {
    return getMessage(
      value === "company" ? "onboardingBusiness.businessTypeCompany" : "onboardingBusiness.businessTypeIndividual",
    );
  }

  return value;
}

/** The value of one address field; the country shows its name beside its code. */
function addressValue(
  field: BusinessAddressField,
  value: string | null,
  snapshot: ProcessorProfileSnapshot,
): string {
  if (value === null) {
    return getMessage("onboardingReview.fieldMissing");
  }

  if (field === "country_code") {
    return snapshot.countryName === null
      ? value
      : formatMessage("onboardingReview.countryValue", { code: value, name: snapshot.countryName });
  }

  return value;
}

function storedAtSentence(snapshot: ProcessorProfileSnapshot): string {
  if (snapshot.savedAtEpochMs === null) {
    return getMessage("onboardingReview.unsavedLine");
  }

  return formatMessage("onboardingReview.savedLine", {
    at: new Date(snapshot.savedAtEpochMs).toISOString().replace("T", " ").slice(0, 19),
  });
}

export default async function OnboardingReviewPage(): Promise<ReactNode> {
  const state = await readReviewState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className={headerClasses}>
          <p className={eyebrowClasses}>{getMessage("onboardingReview.eyebrow")}</p>
          <h1 className={titleClasses}>{getMessage("onboardingReview.title")}</h1>
          <p className={descriptionClasses}>{getMessage("onboardingReview.description")}</p>
          <p className={noteClasses}>{getMessage("onboardingReview.guardNote")}</p>
        </header>

        {state.kind === "ready" ? (
          <ReviewBody snapshot={state.snapshot} />
        ) : (
          <p className={alertClasses} role="alert">
            {state.kind === "signed-out"
              ? getMessage("onboardingReview.signedOut")
              : state.kind === "forbidden"
                ? getMessage("onboardingReview.forbidden")
                : getMessage("onboardingReview.unavailable")}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("onboarding.signInLink")}
            </Link>
          ) : (
            <Link className={linkClasses} href="/onboarding">
              {getMessage("onboardingReview.backLink")}
            </Link>
          )}
          <Link className={linkClasses} href="/sessions">
            {getMessage("onboarding.sessionsLink")}
          </Link>
          <Link className={linkClasses} href="/">
            {getMessage("onboarding.homeLink")}
          </Link>
        </nav>
      </div>
    </main>
  );
}

function ReviewBody({ snapshot }: { readonly snapshot: ProcessorProfileSnapshot }): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      {snapshot.ready ? (
        <p className={readyClasses} role="status">
          {getMessage("onboardingReview.readyLine")}
        </p>
      ) : (
        <p className={alertClasses} role="alert">
          {formatMessage("onboardingReview.missingLine", {
            count: snapshot.blocking.length,
            fields: snapshot.blocking.map(blockingLabel).join(", "),
          })}
        </p>
      )}

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingReview.businessHeading")}</h2>
        <dl className={definitionClasses}>
          {BUSINESS_PROFILE_FIELDS.map((field) => (
            <div key={field} className={rowClasses}>
              <dt className={termClasses}>{getMessage(BUSINESS_LABELS[field])}</dt>
              <dd className={valueClasses}>{businessValue(field, snapshot.business[field])}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingReview.categoryHeading")}</h2>
        <p className={valueClasses}>
          {snapshot.category === null
            ? getMessage("onboardingReview.fieldMissing")
            : formatMessage("onboardingCategory.selectedLine", {
                code: snapshot.category.code,
                title: snapshot.category.title ?? snapshot.category.code,
              })}
        </p>
      </section>

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingReview.addressHeading")}</h2>
        <dl className={definitionClasses}>
          {BUSINESS_ADDRESS_FIELDS.map((field) => (
            <div key={field} className={rowClasses}>
              <dt className={termClasses}>{getMessage(ADDRESS_LABELS[field])}</dt>
              <dd className={valueClasses}>{addressValue(field, snapshot.address[field], snapshot)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={sectionClasses}>
        <h2 className={sectionHeadingClasses}>{getMessage("onboardingReview.processorsHeading")}</h2>
        <p className={descriptionClasses}>{getMessage("onboardingReview.processorsDescription")}</p>
        <ul className="flex flex-col gap-2">
          {snapshot.coverage.map((entry) => (
            <li key={entry.provider} className={processorClasses}>
              <span className="font-semibold">{entry.displayName}</span>
              <span className={entry.missing.length === 0 ? readyClasses : alertClasses}>
                {entry.missing.length === 0
                  ? getMessage("onboardingBusiness.coverageComplete")
                  : formatMessage("onboardingBusiness.coverageMissing", {
                      fields: entry.missing.map((field) => getMessage(BUSINESS_LABELS[field])).join(", "),
                    })}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <p className={noteClasses}>{storedAtSentence(snapshot)}</p>
    </div>
  );
}

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-sm font-medium text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground";

const noteClasses = "max-w-3xl text-xs text-muted-foreground";

const alertClasses = "text-sm text-destructive";

const readyClasses = "text-sm text-foreground";

const sectionClasses = "flex flex-col gap-3 rounded-sm border border-border p-4";

const sectionHeadingClasses = "text-base font-semibold";

const definitionClasses = "flex flex-col gap-2";

const rowClasses = "flex flex-col gap-1 sm:flex-row sm:gap-4";

const termClasses = "text-sm text-muted-foreground sm:w-56 sm:shrink-0";

const valueClasses = "text-sm";

const processorClasses =
  "flex flex-col gap-1 rounded-sm border border-border p-3 text-sm sm:flex-row sm:items-baseline sm:gap-4";

const linkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";
