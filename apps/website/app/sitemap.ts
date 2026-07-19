import type { MetadataRoute } from "next";
import { absoluteSiteUrl } from "@/lib/site";
import { source } from "@/lib/source";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      changeFrequency: "weekly",
      priority: 1,
      url: absoluteSiteUrl(),
    },
    {
      changeFrequency: "weekly",
      priority: 0.9,
      url: absoluteSiteUrl("/playground"),
    },
    ...source.getPages().map((page) => ({
      changeFrequency: "weekly" as const,
      priority: page.slugs.length === 0 ? 0.9 : 0.7,
      url: absoluteSiteUrl(page.url),
    })),
  ];
}
