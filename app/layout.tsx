// path: app/layout.tsx
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "KD Solution IT",
  description:
    "Enterprise multi-tenant payment facilitator platform for Asian merchants with worldwide merchant country control.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
