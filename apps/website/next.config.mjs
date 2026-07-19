import { createMDX } from "fumadocs-mdx/next";

const configuredBasePath = process.env.RENDERIFY_SITE_BASE_PATH?.trim() ?? "";
const basePath = configuredBasePath
  ? `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`
  : "";

/** @type {import("next").NextConfig} */
const config = {
  basePath,
  env: {
    NEXT_PUBLIC_RENDERIFY_BASE_PATH: basePath,
  },
  images: {
    unoptimized: true,
  },
  output: "export",
  poweredByHeader: false,
  reactStrictMode: true,
  trailingSlash: true,
};

export default createMDX()(config);
