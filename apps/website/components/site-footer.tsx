import Image from "next/image";
import Link from "next/link";
import logoMark from "@/assets/brand/renderify-mark.webp";
import { siteConfig } from "@/lib/site";

const COLUMNS = [
  {
    title: "Documentation",
    links: [
      { label: "Getting started", href: "/docs/getting-started" },
      { label: "Browser integration", href: "/docs/browser-integration" },
      { label: "RuntimePlan IR", href: "/docs/runtime-plan-ir" },
      { label: "Security guide", href: "/docs/security" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "Playground", href: "/playground" },
      { label: "GitHub", href: siteConfig.githubUrl, external: true },
      {
        label: "npm",
        href: "https://www.npmjs.com/package/renderify",
        external: true,
      },
      {
        label: "Releases",
        href: `${siteConfig.githubUrl}/releases`,
        external: true,
      },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="home-container site-footer-inner">
        <div className="site-footer-brand">
          <Link className="renderify-brand" href="/">
            <Image alt="" className="renderify-brand-mark" src={logoMark} />
            <span>Renderify</span>
          </Link>
          <p>
            Runtime-first rendering for validated RuntimePlans and reviewed
            JSX/TSX, right in the browser.
          </p>
        </div>
        {COLUMNS.map((column) => (
          <nav aria-label={column.title} key={column.title}>
            <h2>{column.title}</h2>
            <ul>
              {column.links.map((link) => (
                <li key={link.label}>
                  {"external" in link ? (
                    <a href={link.href} rel="noreferrer" target="_blank">
                      {link.label}
                    </a>
                  ) : (
                    <Link href={link.href}>{link.label}</Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="home-container site-footer-legal">
        <p>
          Released under the{" "}
          <a
            href={`${siteConfig.githubUrl}/blob/main/LICENSE`}
            rel="noreferrer"
            target="_blank"
          >
            MIT License
          </a>
          . Copyright © 2026 Web LLM.
        </p>
      </div>
    </footer>
  );
}
