export const siteConfig = {
  name: "Renderify",
  description:
    "A runtime-first renderer for validated RuntimePlans and reviewed JSX/TSX source.",
  docsRepositoryPath: "apps/website/content/docs",
  githubUrl: "https://github.com/webllm/renderify",
  productionUrl: "https://webllm.github.io/renderify",
} as const;

export function absoluteSiteUrl(path = "/"): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${siteConfig.productionUrl}${normalized}`;
}
