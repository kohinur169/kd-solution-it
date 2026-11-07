// path: app/(public)/page.tsx
import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { buildPublicMetadata } from "@/components/public/seo";
import structure from "@/config/structure.json";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { en } from "@/lib/i18n/strings/en";

/**
 * The home page, inside the public shell.
 *
 * STEP 231 moves the foundation's landing route from `app/page.tsx` into this group unchanged, so
 * that the public layout has one page to render and the site's home is a page of the site rather
 * than a page beside it. The copy is still the foundation's - the guarantees the platform makes and
 * the structure gate's count - and STEP 232 replaces it with the home page the CMS publishes. The
 * only edit here is the height: the page no longer owns the whole viewport, because it now sits
 * between a header and a footer, so it takes the space that is left (`flex-1`) instead of forcing
 * a screen height of its own.
 *
 * The metadata is built by `buildPublicMetadata`, which is what every public page will call: the
 * home page asks for an absolute title, because its title is the site's own name and the layout's
 * template would otherwise append it twice.
 */
export const metadata: Metadata = buildPublicMetadata({
  title: en.brand.name,
  description: en.brand.description,
  path: "/",
  absoluteTitle: true,
});

export default function PublicHomePage(): ReactNode {
  const canonicalDirectoryCount = structure.directories.length;
  const rootFileCount = structure.rootFiles.length;

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10 text-foreground sm:px-6">
      <section className="w-full max-w-3xl rounded-card border border-border bg-surface p-6 shadow-card sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {getMessage("home.eyebrow")}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          {getMessage("brand.name")}
        </h1>
        <p className="mt-3 text-base text-muted-foreground sm:text-lg">
          {getMessage("brand.description")}
        </p>
        <ul className="mt-6 grid gap-3">
          {Object.values(en.home.facts).map((fact) => (
            <li key={fact} className="border-l-2 border-primary pl-3 text-sm">
              {fact}
            </li>
          ))}
        </ul>
        <p className="mt-7 border-t border-border pt-5 text-sm text-muted-foreground">
          {formatMessage("home.structureGate", {
            directories: canonicalDirectoryCount,
            rootFiles: rootFileCount,
          })}
        </p>
        <p className="mt-3 text-sm">
          <Link
            className="font-semibold text-primary underline-offset-4 hover:underline"
            href="/api/health"
          >
            {getMessage("home.healthLink")}
          </Link>
        </p>
      </section>
    </main>
  );
}
