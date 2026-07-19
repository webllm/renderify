import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Provider } from "@/components/provider";
import { siteConfig } from "@/lib/site";
import "./global.css";

export const metadata: Metadata = {
  metadataBase: new URL(`${siteConfig.productionUrl}/`),
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
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
