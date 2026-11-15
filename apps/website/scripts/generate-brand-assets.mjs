// Regenerates the website brand assets from the repository logo.png.
//
// Usage:
//   pnpm --filter @renderify/website brand:assets
//   pnpm --filter @renderify/website brand:assets -- --chromium /path/to/chrome
//
// Rasterization runs in Chromium through the repository's Playwright dev
// dependency so resampling and PNG encoding are identical on every platform.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const websiteRoot = fileURLToPath(new URL("..", import.meta.url));
const logoPath = fileURLToPath(new URL("../../../logo.png", import.meta.url));

/**
 * @typedef {object} BrandAsset
 * @property {string} file Output path relative to the website root.
 * @property {number} width Output width in pixels.
 * @property {number} [height] Output height; defaults to the logo aspect ratio.
 * @property {number} [padding] Inset as a fraction of the shorter edge.
 * @property {"apple"} [background] Optional opaque background treatment.
 */

// In-page assets use WebP: the logo's smooth gradient is ~6x smaller than PNG
// with no visible difference. Icons stay PNG for platform compatibility.
/** @type {BrandAsset[]} */
const assets = [
  { file: "assets/brand/renderify-logo.webp", width: 512 },
  { file: "assets/brand/renderify-mark.webp", width: 96 },
  { file: "app/icon.png", width: 144, height: 144, padding: 0.04 },
  {
    file: "app/apple-icon.png",
    width: 180,
    height: 180,
    padding: 0.2,
    background: "apple",
  },
];

const chromiumFlagIndex = process.argv.indexOf("--chromium");
const executablePath =
  chromiumFlagIndex === -1 ? undefined : process.argv[chromiumFlagIndex + 1];

const logoSource = `data:image/png;base64,${(await readFile(logoPath)).toString("base64")}`;
const browser = await chromium.launch(
  executablePath ? { executablePath } : undefined,
);

try {
  const page = await browser.newPage();
  for (const asset of assets) {
    const base64 = await page.evaluate(renderAsset, {
      asset,
      source: logoSource,
    });
    const outputPath = `${websiteRoot}${asset.file}`;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(base64, "base64"));
    console.log(`wrote ${relative(process.cwd(), outputPath)}`);
  }
} finally {
  await browser.close();
}

/**
 * Runs inside Chromium. Fits the logo into the requested canvas and returns
 * the encoded image (PNG or WebP, by file extension) as base64.
 *
 * @param {{ asset: BrandAsset; source: string }} input
 */
async function renderAsset({ asset, source }) {
  const image = new Image();
  image.src = source;
  await image.decode();

  const width = asset.width;
  const height =
    asset.height ??
    Math.round((asset.width * image.naturalHeight) / image.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("2D canvas is unavailable");
  }

  if (asset.background === "apple") {
    const base = context.createLinearGradient(0, 0, width, height);
    base.addColorStop(0, "#151a3d");
    base.addColorStop(1, "#070912");
    context.fillStyle = base;
    context.fillRect(0, 0, width, height);
    const glow = context.createRadialGradient(
      width * 0.5,
      height * 0.46,
      0,
      width * 0.5,
      height * 0.46,
      width * 0.62,
    );
    glow.addColorStop(0, "rgb(11 92 250 / 38%)");
    glow.addColorStop(1, "rgb(11 92 250 / 0%)");
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
  }

  const inset = Math.round(Math.min(width, height) * (asset.padding ?? 0));
  const scale = Math.min(
    (width - inset * 2) / image.naturalWidth,
    (height - inset * 2) / image.naturalHeight,
  );
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;

  // Halve the source until it is within 2x of the target so the final
  // high-quality resample does not skip source pixels.
  /** @type {CanvasImageSource} */
  let current = image;
  let currentWidth = image.naturalWidth;
  let currentHeight = image.naturalHeight;
  while (currentWidth / 2 >= drawWidth) {
    const step = document.createElement("canvas");
    step.width = Math.round(currentWidth / 2);
    step.height = Math.round(currentHeight / 2);
    const stepContext = step.getContext("2d");
    if (!stepContext) {
      throw new Error("2D canvas is unavailable");
    }
    stepContext.imageSmoothingQuality = "high";
    stepContext.drawImage(current, 0, 0, step.width, step.height);
    current = step;
    currentWidth = step.width;
    currentHeight = step.height;
  }

  context.imageSmoothingQuality = "high";
  context.drawImage(
    current,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  return asset.file.endsWith(".webp")
    ? canvas.toDataURL("image/webp", 0.9).split(",")[1]
    : canvas.toDataURL("image/png").split(",")[1];
}
