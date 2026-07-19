import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { siteConfig } from "./site";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="renderify-brand">
          <span aria-hidden="true" className="renderify-brand-mark">
            R
          </span>
          Renderify
        </span>
      ),
    },
    links: [
      {
        text: "Docs",
        url: "/docs",
        active: "nested-url",
      },
      {
        text: "Playground",
        url: "/playground",
        active: "url",
      },
    ],
    githubUrl: siteConfig.githubUrl,
  };
}
