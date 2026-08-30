import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";

import "./globals.css";
import "./responsive.css";

export const metadata: Metadata = {
  title: {
    default: "MRE Command Center",
    template: "%s · XynPrize",
  },
  description: "XynPrize Ltd.'s intelligent command and automation workspace.",
  applicationName: "MRE",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#020617",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to command workspace
        </a>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
