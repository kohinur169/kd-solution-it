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
    <main className="page">
      <div className="shell">
        <p className="eyebrow">Foundation</p>
        <h1 className="display">KD Solution IT</h1>
        <p className="lede">{platformSummary}</p>
        <ul className="facts">
          {foundationFacts.map((fact) => (
            <li key={fact} className="fact">
              {fact}
            </li>
          ))}
        </ul>
        <p className="meta">
          The structure gate enforces {canonicalDirectoryCount} canonical directories and{" "}
          {rootFileCount} root files on every verification run.
        </p>
        <p className="meta">
          <Link className="link" href="/api/health">
            Service health
          </Link>
        </p>
      </div>
    </main>
  );
}
