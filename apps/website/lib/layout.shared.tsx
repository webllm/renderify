import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Image from "next/image";
import logoMark from "@/assets/brand/renderify-mark.webp";
import { siteConfig } from "./site";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="renderify-brand">
          <Image
            alt=""
            className="renderify-brand-mark"
            loading="eager"
            src={logoMark}
          />
          <span>Renderify</span>
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
