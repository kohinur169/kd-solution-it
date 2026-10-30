// path: app/page.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import structure from "@/config/structure.json";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { en } from "@/lib/i18n/strings/en";

export default function HomePage(): ReactNode {
  const canonicalDirectoryCount = structure.directories.length;
  const rootFileCount = structure.rootFiles.length;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-6 text-foreground sm:px-6">
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
