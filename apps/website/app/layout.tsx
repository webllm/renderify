import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Provider } from "@/components/provider";
import { siteConfig } from "@/lib/site";
import "./global.css";

const geistSans = Geist({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const geistMono = Geist_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  // File-based metadata images (icons, Open Graph card) already carry the
  // basePath, so resolve them against the production origin only.
  metadataBase: new URL(new URL(siteConfig.productionUrl).origin),
  title: {
    default: "Renderify — Runtime-first UI rendering",
    template: "%s | Renderify",
  },
  description: siteConfig.description,
  openGraph: {
    description: siteConfig.description,
    siteName: siteConfig.name,
    title: "Renderify — Runtime-first UI rendering",
    type: "website",
    url: siteConfig.productionUrl,
  },
  twitter: {
    card: "summary_large_image",
    description: siteConfig.description,
    title: "Renderify — Runtime-first UI rendering",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      className={`${geistSans.variable} ${geistMono.variable}`}
      lang="en"
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
