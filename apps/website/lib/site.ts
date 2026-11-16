export const siteConfig = {
  name: "Renderify",
  description:
    "Render the UI your model describes: validated RuntimePlans by default, model-written JSX in a sandboxed iframe when you need more.",
  docsRepositoryPath: "docs",
  githubUrl: "https://github.com/webllm/renderify",
  productionUrl: "https://webllm.github.io/renderify",
} as const;

export function absoluteSiteUrl(path = "/"): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${siteConfig.productionUrl}${normalized}`;
}
