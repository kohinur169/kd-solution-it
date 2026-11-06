// path: app/(dashboard)/invoices/branding/branding-form.tsx
"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import type {
  InvoiceBrandingIdentity,
  InvoiceBrandingNameStyle,
  InvoiceBrandingSnapshot,
} from "@/services/invoices/invoice-branding";

/**
 * The invoice branding form: the merchant's logo and the details their invoices print about them.
 *
 * ## Why two forms on one page
 *
 * An upload is bytes and a save is ten short fields, and they are two different requests: multipart to the
 * logo route, JSON to the settings route. Keeping them as two sibling forms means uploading a logo does not
 * post half-edited settings with it, and saving a tagline does not re-upload a two megabyte picture. They are
 * siblings and never nested, because a form inside a form is not HTML.
 *
 * ## Why the preview is the headline
 *
 * A toggle called "print my address" is abstract; the four lines it produces are not. The block at the top of
 * the settings form is drawn from the form's own state as it changes, and it is drawn the same way the server
 * draws the saved preview and the renderer draws the document - one function restated in three places, with
 * the server's version the one the gate proves. A merchant who turns the tax id on sees the line appear
 * before they commit to printing it on a document a client keeps.
 *
 * ## Why the logo has two nouns
 *
 * "The newest logo" is what the last upload produced, and "the logo that prints" is what the settings name.
 * They are the same file almost always, and the screen says so plainly when they are not: an upload that
 * could not be adopted - a WebP, or bytes that did not match the format they claimed - leaves the invoice
 * logo alone, and a merchant who is not told that will wonder why their document never changed.
 *
 * ## Why every field's error is its own
 *
 * The service answers with a list of `{field, rule}` pairs. A form that showed one message at the top would
 * leave the merchant hunting for which of ten controls was wrong.
 */

const RULE_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  invalid_format: "invoices.ruleInvalidFormat",
  too_long: "invoices.brandingTooLong",
  stale: "invoices.brandingStale",
  file_not_acceptable: "invoices.brandingLogoNotPrintable",
});

function ruleSentence(rule: string | null, field: string): string {
  if (rule === "invalid_format" && field === "accent_colour") {
    return getMessage("invoices.brandingBadColour");
  }

  if (rule === null) {
    return getMessage("invoices.fieldInvalid");
  }

  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("invoices.fieldInvalid") : getMessage(key);
}

function refusalDetails(payload: unknown): readonly { readonly field?: unknown; readonly rule?: unknown }[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return [];
  }

  const details = (error as { readonly details?: unknown }).details;

  return Array.isArray(details) ? details.filter((detail) => typeof detail === "object") : [];
}

/** The answer of either route, read without trusting its shape. */
function snapshotOf(payload: unknown): InvoiceBrandingSnapshot | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const snapshot = (payload as { readonly snapshot?: unknown }).snapshot;

  if (typeof snapshot !== "object" || snapshot === null) {
    return null;
  }

  const body = snapshot as { readonly settings?: unknown; readonly identity?: unknown };

  return typeof body.settings === "object" && typeof body.identity === "object"
    ? (snapshot as InvoiceBrandingSnapshot)
    : null;
}

const inputClasses =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-primary";
const labelClasses = "text-sm font-medium";
const hintClasses = "text-xs text-muted-foreground";
const errorClasses = "text-xs text-destructive";
const buttonClasses =
  "w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50";
const secondaryButtonClasses =
  "w-fit rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50";

/** A byte count a merchant reads, in the units they used when the file was on their desktop. */
function sizeOf(byteSize: number): string {
  return byteSize >= 1_048_576
    ? `${(byteSize / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(byteSize / 1024))} KB`;
}

interface PreviewState {
  readonly nameStyle: InvoiceBrandingNameStyle;
  readonly showAddress: boolean;
  readonly showContact: boolean;
  readonly showTaxId: boolean;
  readonly showWebsite: boolean;
  readonly tagline: string;
}

/**
 * The block the PDF will print, computed the way the server computes it.
 *
 * Deliberately a local re-statement rather than an import of `invoiceBrandingWordsOf`: this is a client
 * component, and importing the service would pull the REST client, the storage adapters and the role checks
 * into the browser bundle for the sake of joining four strings. The server's version is the one the gate
 * proves and the one the renderer is handed; what a merchant sees a keystroke early is not a security
 * boundary. The fallback order is the same, because a preview that showed a name the document would not
 * print would be worse than no preview.
 */
function previewLinesOf(identity: InvoiceBrandingIdentity, state: PreviewState): readonly string[] {
  const name =
    state.nameStyle === "legal"
      ? (identity.legalName ?? identity.tradingName ?? identity.companyName)
      : (identity.tradingName ?? identity.legalName ?? identity.companyName);
  const lines: string[] = [];

  if (name !== null && name.length > 0) {
    lines.push(name);
  }

  if (state.tagline.trim().length > 0) {
    lines.push(state.tagline.trim());
  }

  if (state.showAddress) {
    for (const line of identity.addressLines) {
      lines.push(line);
    }
  }

  if (state.showContact) {
    if (identity.email !== null && identity.email.length > 0) {
      lines.push(identity.email);
    }

    if (identity.phone !== null && identity.phone.length > 0) {
      lines.push(identity.phone);
    }
  }

  if (state.showWebsite && identity.website !== null && identity.website.length > 0) {
    lines.push(identity.website);
  }

  if (state.showTaxId && identity.taxId !== null && identity.taxId.length > 0) {
    lines.push(formatMessage("invoices.brandingTaxIdLine", { taxId: identity.taxId }));
  }

  return lines;
}

export interface BrandingFormProps {
  readonly snapshot: InvoiceBrandingSnapshot;
  /**
   * The colour the picker opens on when the merchant switches an accent on and has not chosen one. Handed
   * down rather than written here, because a screen holds no colour: STEP 003's shell gate refuses a colour
   * literal under `app/` and the merchant's accent is data that lives with the settings.
   */
  readonly defaultAccent: string;
}

export function BrandingForm({ snapshot, defaultAccent }: BrandingFormProps): ReactNode {
  const { settings, identity } = snapshot;
  const [nameStyle, setNameStyle] = useState<InvoiceBrandingNameStyle>(settings.nameStyle);
  const [showLogo, setShowLogo] = useState<boolean>(settings.showLogo);
  const [showAddress, setShowAddress] = useState<boolean>(settings.showAddress);
  const [showContact, setShowContact] = useState<boolean>(settings.showContact);
  const [showTaxId, setShowTaxId] = useState<boolean>(settings.showTaxId);
  const [showWebsite, setShowWebsite] = useState<boolean>(settings.showWebsite);
  const [tagline, setTagline] = useState<string>(settings.tagline ?? "");
  const [footerNote, setFooterNote] = useState<string>(settings.footerNote ?? "");
  const [accentOn, setAccentOn] = useState<boolean>(settings.accentColour !== null);
  const [accent, setAccent] = useState<string>(settings.accentColour ?? defaultAccent);
  const [version, setVersion] = useState<number>(settings.version);
  const [logoFileId, setLogoFileId] = useState<string | null>(settings.logoFileId);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<boolean>(false);
  const [uploading, setUploading] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const [logoNote, setLogoNote] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(snapshot.newestLogoUrl);
  const [newestLogoId, setNewestLogoId] = useState<string | null>(snapshot.newestLogo?.fileId ?? null);
  // Whether the newest stored file can be drawn at all. A WebP is accepted by the upload policy and refused
  // by the PDF writer, so it is stored, verified and unprintable: offering a button that switches the invoice
  // over to it would be offering an action that always ends in a refusal.
  const [newestLogoPrintable, setNewestLogoPrintable] = useState<boolean>(
    snapshot.newestLogo?.printable === true,
  );
  const [adoptedLogoId, setAdoptedLogoId] = useState<string | null>(snapshot.adoptedLogo?.fileId ?? null);

  const preview = previewLinesOf(identity, {
    nameStyle,
    showAddress,
    showContact,
    showTaxId,
    showWebsite,
    tagline,
  });
  const identityEmpty =
    identity.companyName === null &&
    identity.tradingName === null &&
    identity.legalName === null &&
    identity.addressLines.length === 0;

  /** Take the settings half of either answer and re-seed the form from what the server now holds. */
  function adopt(next: InvoiceBrandingSnapshot): void {
    setVersion(next.settings.version);
    setLogoFileId(next.settings.logoFileId);
    setShowLogo(next.settings.showLogo);
    setNameStyle(next.settings.nameStyle);
    setShowAddress(next.settings.showAddress);
    setShowContact(next.settings.showContact);
    setShowTaxId(next.settings.showTaxId);
    setShowWebsite(next.settings.showWebsite);
    setTagline(next.settings.tagline ?? "");
    setFooterNote(next.settings.footerNote ?? "");
    setAccentOn(next.settings.accentColour !== null);
    setAccent(next.settings.accentColour ?? accent);
    setLogoUrl(next.newestLogoUrl);
    setNewestLogoId(next.newestLogo?.fileId ?? null);
    setNewestLogoPrintable(next.newestLogo?.printable === true);
    setAdoptedLogoId(next.adoptedLogo?.fileId ?? null);
  }

  function markRefusal(payload: unknown): void {
    const nextErrors: Record<string, string> = {};

    for (const detail of refusalDetails(payload)) {
      const field = typeof detail.field === "string" ? detail.field : null;

      if (field !== null && nextErrors[field] === undefined) {
        nextErrors[field] = ruleSentence(typeof detail.rule === "string" ? detail.rule : null, field);
      }
    }

    setErrors(nextErrors);
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setMessage(null);
    setFailed(false);

    try {
      const response = await fetch("/api/invoices/branding", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({
          logo_file_id: logoFileId,
          show_logo: showLogo,
          name_style: nameStyle,
          show_address: showAddress,
          show_contact: showContact,
          show_tax_id: showTaxId,
          show_website: showWebsite,
          tagline: tagline.trim().length === 0 ? null : tagline,
          footer_note: footerNote.trim().length === 0 ? null : footerNote,
          accent_colour: accentOn ? accent.toLowerCase() : null,
          version,
        }),
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        markRefusal(payload);
        setFailed(true);
        setMessage(
          response.status === 409
            ? getMessage("invoices.brandingStale")
            : getMessage("invoices.brandingFailed"),
        );

        return;
      }

      const next = snapshotOf(payload);

      if (next === null) {
        setFailed(true);
        setMessage(getMessage("invoices.brandingFailed"));

        return;
      }

      adopt(next);
      setMessage(getMessage("invoices.brandingSaved"));
    } catch {
      setFailed(true);
      setMessage(getMessage("invoices.brandingFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setUploading(true);
    setMessage(null);
    setFailed(false);
    setLogoNote(null);

    const form = new FormData(event.currentTarget);
    const file = form.get("file");

    if (!(file instanceof File) || file.size === 0) {
      setUploading(false);
      setLogoNote(getMessage("invoices.brandingLogoUploadFailed"));

      return;
    }

    const body = new FormData();

    body.set("file", file);

    try {
      const response = await fetch("/api/invoices/branding/logo", {
        method: "POST",
        headers: { ...(await csrfHeaders()) },
        body,
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setFailed(true);
        setMessage(getMessage("invoices.brandingLogoUploadFailed"));

        return;
      }

      const answer = payload as { readonly adopted?: unknown; readonly quarantined?: unknown };
      const next = snapshotOf(payload);

      if (next !== null) {
        adopt(next);
      }

      setLogoNote(
        answer.quarantined === true
          ? getMessage("invoices.brandingLogoQuarantined")
          : answer.adopted === true
            ? getMessage("invoices.brandingLogoCurrent")
            : getMessage("invoices.brandingLogoNotPrintable"),
      );
      event.currentTarget.reset();
    } catch {
      setFailed(true);
      setMessage(getMessage("invoices.brandingLogoUploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  function errorLine(field: string): ReactNode {
    const error = errors[field];

    return error === undefined ? null : (
      <p className={errorClasses} role="alert">
        {error}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <h2 className="text-xs font-medium text-muted-foreground">
          {getMessage("invoices.brandingLogoHeading")}
        </h2>

        {/* One column on a phone, picture beside the controls from `sm` up: the picture is 96 points wide and
            a 360px screen has no room for it beside a button. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
            {logoUrl === null ? (
              <span className="px-2 text-center text-xs text-muted-foreground">
                {getMessage("invoices.brandingLogoHeading")}
              </span>
            ) : (
              // A short-lived signed URL of the merchant's own logo, minted for this response and `no-store`.
              // eslint-disable-next-line @next/next/no-img-element
              <img alt="" className="max-h-full max-w-full object-contain" src={logoUrl} />
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <p className="text-sm">
              {adoptedLogoId === null
                ? getMessage("invoices.brandingLogoNone")
                : showLogo
                  ? getMessage("invoices.brandingLogoCurrent")
                  : getMessage("invoices.brandingLogoHidden")}
            </p>

            {snapshot.newestLogo === null ? null : (
              <p className={hintClasses}>
                {formatMessage("invoices.brandingLogoFile", {
                  format: snapshot.newestLogo.contentType,
                  size: sizeOf(snapshot.newestLogo.byteSize),
                })}
              </p>
            )}

            <label className="flex items-center gap-2 text-sm font-medium" htmlFor="branding-show-logo">
              <input
                checked={showLogo}
                id="branding-show-logo"
                onChange={(event) => {
                  setShowLogo(event.target.checked);
                  setErrors({});
                }}
                type="checkbox"
              />
              {getMessage("invoices.brandingLogoShow")}
            </label>

            {/* Two sibling forms would be two submit buttons in one row; this one uploads and nothing else. */}
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
              onSubmit={(event) => {
                void upload(event);
              }}
            >
              <label className="sr-only" htmlFor="branding-logo-file">
                {getMessage("invoices.brandingLogoUpload")}
              </label>
              <input
                accept="image/png,image/jpeg,image/webp"
                className="min-w-0 flex-1 text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-2 file:text-xs file:font-medium file:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                id="branding-logo-file"
                name="file"
                type="file"
              />
              <button className={secondaryButtonClasses} disabled={uploading} type="submit">
                {getMessage(
                  uploading
                    ? "invoices.brandingLogoUploading"
                    : adoptedLogoId === null
                      ? "invoices.brandingLogoUpload"
                      : "invoices.brandingLogoReplace",
                )}
              </button>
            </form>

            {newestLogoId !== null && newestLogoId !== adoptedLogoId && newestLogoPrintable ? (
              <button
                className={secondaryButtonClasses}
                disabled={busy}
                onClick={() => {
                  setLogoFileId(newestLogoId);
                  setShowLogo(true);
                  setErrors({});
                  setMessage(null);
                }}
                type="button"
              >
                {getMessage("invoices.brandingLogoUseNewer")}
              </button>
            ) : null}

            <p className={hintClasses}>{getMessage("invoices.brandingLogoFormatNote")}</p>

            {logoNote === null ? null : (
              <p className={hintClasses} role="status">
                {logoNote}
              </p>
            )}
          </div>
        </div>
      </section>

      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <h2 className="text-xs font-medium text-muted-foreground">
            {getMessage("invoices.brandingPreviewHeading")}
          </h2>
          {/* The block the PDF draws, at the sizes the PDF draws it: a name in bold, then the smaller lines. */}
          <div className="rounded-md border border-border bg-muted/40 p-4">
            {preview.length === 0 ? (
              <p className="text-sm text-muted-foreground">{getMessage("invoices.brandingPreviewEmpty")}</p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {preview.map((line, index) => (
                  <p
                    className={index === 0 ? "text-sm font-semibold" : "text-xs text-muted-foreground"}
                    key={`${index}-${line}`}
                  >
                    {line}
                  </p>
                ))}
              </div>
            )}
          </div>
          <p className={hintClasses}>{getMessage("invoices.brandingPreviewHint")}</p>

          {identityEmpty ? (
            <div className="flex flex-col gap-1 rounded-md border border-border p-3">
              <p className="text-xs text-destructive" role="alert">
                {getMessage("invoices.brandingNoProfile")}
              </p>
              <Link
                className="w-fit rounded-sm text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary"
                href="/onboarding/business"
              >
                {getMessage("invoices.brandingProfileLink")}
              </Link>
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-4 rounded-lg border border-border p-4">
          <h2 className="text-xs font-medium text-muted-foreground">
            {getMessage("invoices.brandingIdentityHeading")}
          </h2>

          <fieldset className="flex flex-col gap-2">
            <legend className={labelClasses}>{getMessage("invoices.brandingNameStyle")}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm" htmlFor="branding-name-trading">
                <input
                  checked={nameStyle === "trading"}
                  id="branding-name-trading"
                  name="name_style"
                  onChange={() => {
                    setNameStyle("trading");
                  }}
                  type="radio"
                  value="trading"
                />
                {getMessage("invoices.brandingNameTrading")}
                <span className={hintClasses}>
                  {identity.tradingName ?? identity.companyName ?? "\u2014"}
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm" htmlFor="branding-name-legal">
                <input
                  checked={nameStyle === "legal"}
                  id="branding-name-legal"
                  name="name_style"
                  onChange={() => {
                    setNameStyle("legal");
                  }}
                  type="radio"
                  value="legal"
                />
                {getMessage("invoices.brandingNameLegal")}
                <span className={hintClasses}>
                  {identity.legalName ?? identity.companyName ?? "\u2014"}
                </span>
              </label>
            </div>
          </fieldset>

          <div className="grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm" htmlFor="branding-show-address">
              <input
                checked={showAddress}
                id="branding-show-address"
                onChange={(event) => {
                  setShowAddress(event.target.checked);
                }}
                type="checkbox"
              />
              {getMessage("invoices.brandingShowAddress")}
            </label>
            <label className="flex items-center gap-2 text-sm" htmlFor="branding-show-contact">
              <input
                checked={showContact}
                id="branding-show-contact"
                onChange={(event) => {
                  setShowContact(event.target.checked);
                }}
                type="checkbox"
              />
              {getMessage("invoices.brandingShowContact")}
            </label>
            <label className="flex items-center gap-2 text-sm" htmlFor="branding-show-tax-id">
              <input
                checked={showTaxId}
                id="branding-show-tax-id"
                onChange={(event) => {
                  setShowTaxId(event.target.checked);
                }}
                type="checkbox"
              />
              {getMessage("invoices.brandingShowTaxId")}
            </label>
            <label className="flex items-center gap-2 text-sm" htmlFor="branding-show-website">
              <input
                checked={showWebsite}
                id="branding-show-website"
                onChange={(event) => {
                  setShowWebsite(event.target.checked);
                }}
                type="checkbox"
              />
              {getMessage("invoices.brandingShowWebsite")}
            </label>
          </div>

          <div className="flex flex-col gap-1 border-t border-border pt-4">
            <label className={labelClasses} htmlFor="branding-tagline">
              {getMessage("invoices.brandingTaglineLabel")}
            </label>
            <input
              aria-invalid={errors["tagline"] !== undefined}
              className={inputClasses}
              id="branding-tagline"
              maxLength={120}
              onChange={(event) => {
                setTagline(event.target.value);
                setErrors({});
              }}
              type="text"
              value={tagline}
            />
            {errors["tagline"] === undefined ? (
              <p className={hintClasses}>{getMessage("invoices.brandingTaglineHint")}</p>
            ) : (
              errorLine("tagline")
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor="branding-footer-note">
              {getMessage("invoices.brandingFooterNoteLabel")}
            </label>
            <textarea
              aria-invalid={errors["footer_note"] !== undefined}
              className={inputClasses}
              id="branding-footer-note"
              maxLength={300}
              onChange={(event) => {
                setFooterNote(event.target.value);
                setErrors({});
              }}
              rows={3}
              value={footerNote}
            />
            {errors["footer_note"] === undefined ? (
              <p className={hintClasses}>{getMessage("invoices.brandingFooterNoteHint")}</p>
            ) : (
              errorLine("footer_note")
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <label className="flex items-center gap-2 text-sm font-medium" htmlFor="branding-accent-default">
              <input
                checked={!accentOn}
                id="branding-accent-default"
                onChange={(event) => {
                  setAccentOn(!event.target.checked);
                  setErrors({});
                }}
                type="checkbox"
              />
              {getMessage("invoices.brandingAccentDefault")}
            </label>
            <p className={hintClasses}>{getMessage("invoices.brandingAccentHint")}</p>

            {accentOn ? (
              <div className="flex flex-col gap-1">
                <label className={labelClasses} htmlFor="branding-accent">
                  {getMessage("invoices.brandingAccentLabel")}
                </label>
                <input
                  aria-invalid={errors["accent_colour"] !== undefined}
                  className="h-10 w-24 rounded-md border border-border bg-background p-1 focus-visible:ring-2 focus-visible:ring-primary"
                  id="branding-accent"
                  onChange={(event) => {
                    setAccent(event.target.value);
                    setErrors({});
                  }}
                  type="color"
                  value={accent}
                />
                {errorLine("accent_colour")}
              </div>
            ) : null}
          </div>

          {errorLine("logo")}

          <button className={buttonClasses} disabled={busy} type="submit">
            {getMessage(busy ? "invoices.brandingSaving" : "invoices.brandingSave")}
          </button>
        </section>

        {message === null ? null : (
          <p className={failed ? errorClasses : hintClasses} role={failed ? "alert" : "status"}>
            {message}
          </p>
        )}

        <nav className="border-t border-border pt-4 text-sm">
          <Link
            className="w-fit rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary"
            href="/invoices"
          >
            {getMessage("invoices.brandingBack")}
          </Link>
        </nav>
      </form>
    </div>
  );
}
