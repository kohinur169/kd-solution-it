// path: app/page.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import structure from "@/config/structure.json";

const platformSummary =
  "Enterprise multi-tenant payment facilitator platform for Asian merchants with worldwide merchant country control.";

const foundationFacts: ReadonlyArray<string> = [
  "Amounts are held in USD only, stored as numeric(18,4) and never calculated with floating point.",
  "Every tenant record is isolated by row level security and every mutation is audit logged.",
  "Files are encrypted with AES-256-GCM before they reach object storage.",
];

export default function HomePage(): ReactNode {
  const canonicalDirectoryCount = structure.directories.length;
  const rootFileCount = structure.rootFiles.length;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-6 text-foreground sm:px-6">
      <section className="w-full max-w-3xl rounded-card border border-border bg-surface p-6 shadow-card sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Foundation
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          KD Solution IT
        </h1>
        <p className="mt-3 text-base text-muted-foreground sm:text-lg">
          {platformSummary}
        </p>
        <ul className="mt-6 grid gap-3">
          {foundationFacts.map((fact) => (
            <li key={fact} className="border-l-2 border-primary pl-3 text-sm">
              {fact}
            </li>
          ))}
        </ul>
        <p className="mt-7 border-t border-border pt-5 text-sm text-muted-foreground">
          The structure gate enforces {canonicalDirectoryCount} canonical directories and{" "}
          {rootFileCount} root files on every verification run.
        </p>
        <p className="mt-3 text-sm">
          <Link
            className="font-semibold text-primary underline-offset-4 hover:underline"
            href="/api/health"
          >
            Service health
          </Link>
        </p>
      </section>
    </main>
  );
}
