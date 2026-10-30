// path: app/layout.tsx
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { en } from "@/lib/i18n/strings/en";
import "./globals.css";

export const metadata: Metadata = {
  title: en.brand.name,
  description: en.brand.description,
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
    <html lang={en.locale.code} dir={en.locale.direction}>
      <body>{children}</body>
    </html>
  );
}
