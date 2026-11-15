import { HomeLayout } from "fumadocs-ui/layouts/home";
import { ArrowLeft, BookOpen } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Logo3D } from "@/components/brand/logo-3d";
import { SiteFooter } from "@/components/site-footer";
import { baseOptions } from "@/lib/layout.shared";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  const options = baseOptions();
  return (
    <>
      <HomeLayout {...options} nav={{ ...options.nav, transparentMode: "top" }}>
        <div className="not-found">
          <div aria-hidden="true" className="not-found-backdrop" />
          <Logo3D eager />
          <p className="not-found-code renderify-gradient-text">404</p>
          <h1>This page was never rendered</h1>
          <p>The requested Renderify page does not exist or has moved.</p>
          <div className="not-found-actions">
            <Link className="home-button home-button-primary" href="/">
              <ArrowLeft aria-hidden="true" size={17} />
              Return home
            </Link>
            <Link className="home-button home-button-secondary" href="/docs">
              <BookOpen aria-hidden="true" size={17} />
              Browse the docs
            </Link>
          </div>
        </div>
      </HomeLayout>
      <SiteFooter />
    </>
  );
}
