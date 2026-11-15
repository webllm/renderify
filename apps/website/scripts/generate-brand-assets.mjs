// Regenerates the website brand assets from the repository logo.png.
//
// Usage:
//   pnpm --filter @renderify/website brand:assets
//   pnpm --filter @renderify/website brand:assets -- --chromium /path/to/chrome
//
// Rasterization runs in Chromium through the repository's Playwright dev
// dependency so resampling and PNG encoding are identical on every platform.
// The Open Graph card loads Geist from Google Fonts; without network access
// it falls back to system fonts.
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
    await writeAsset(asset.file, Buffer.from(base64, "base64"));
  }

  const card = await browser.newPage({
    deviceScaleFactor: 1,
    viewport: { height: 630, width: 1200 },
  });
  await card.setContent(renderSocialCard(logoSource), {
    waitUntil: "networkidle",
  });
  await card.evaluate(() => document.fonts.ready);
  // JPEG keeps the gradient-heavy card around a third of the PNG size.
  await writeAsset(
    "app/opengraph-image.jpg",
    await card.screenshot({ quality: 90, type: "jpeg" }),
  );
} finally {
  await browser.close();
}

/**
 * @param {string} file
 * @param {Uint8Array} data
 */
async function writeAsset(file, data) {
  const outputPath = `${websiteRoot}${file}`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, data);
  console.log(`wrote ${relative(process.cwd(), outputPath)}`);
}

/**
 * The 1200x630 social card: logo, wordmark, and tagline on the brand
 * backdrop with the landing page's receding grid floor.
 *
 * @param {string} logo Logo image source.
 */
function renderSocialCard(logo) {
  return `<!doctype html>
<html>
  <head>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;700&family=Geist+Mono:wght@500&display=block" rel="stylesheet">
    <style>
      * { box-sizing: border-box; margin: 0; }
      body {
        width: 1200px;
        height: 630px;
        overflow: hidden;
        position: relative;
        color: #eef1ff;
        font-family: Geist, ui-sans-serif, system-ui, sans-serif;
        background:
          radial-gradient(560px 420px at 0% 0%, rgb(138 43 249 / 34%), transparent 70%),
          radial-gradient(620px 460px at 30% 60%, rgb(11 92 250 / 30%), transparent 70%),
          radial-gradient(520px 380px at 100% 100%, rgb(0 212 251 / 22%), transparent 70%),
          #070912;
      }
      .floor {
        position: absolute;
        left: -20%;
        right: -20%;
        top: 62%;
        height: 80%;
        background-image:
          linear-gradient(to right, rgb(140 160 255 / 16%) 1px, transparent 1px),
          linear-gradient(to bottom, rgb(140 160 255 / 16%) 1px, transparent 1px);
        background-size: 56px 56px;
        background-position: 50% 0;
        transform: perspective(520px) rotateX(70deg);
        transform-origin: 50% 0;
        -webkit-mask-image: radial-gradient(ellipse 55% 70% at 30% 0%, #000 10%, transparent 72%);
      }
      main {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        gap: 72px;
        padding: 0 96px;
      }
      img {
        width: 330px;
        height: auto;
        filter: drop-shadow(0 30px 60px rgb(11 92 250 / 45%));
      }
      h1 {
        font-size: 104px;
        font-weight: 700;
        letter-spacing: -0.05em;
        line-height: 1;
      }
      p {
        margin-top: 24px;
        max-width: 600px;
        color: rgb(226 232 255 / 78%);
        font-size: 34px;
        line-height: 1.3;
        letter-spacing: -0.01em;
      }
      ul {
        display: flex;
        gap: 10px;
        margin-top: 36px;
        padding: 0;
        list-style: none;
      }
      li {
        padding: 8px 16px;
        border: 1px solid rgb(140 160 255 / 28%);
        border-radius: 999px;
        background: rgb(255 255 255 / 6%);
        color: #c7d6ff;
        font-family: "Geist Mono", ui-monospace, monospace;
        font-size: 18px;
        white-space: nowrap;
      }
    </style>
  </head>
  <body>
    <div class="floor"></div>
    <main>
      <img src="${logo}" alt="">
      <div>
        <h1>Renderify</h1>
        <p>Runtime-first UI rendering for RuntimePlans and reviewed JSX</p>
        <ul>
          <li>Browser-native</li>
          <li>Security-first</li>
          <li>LLM optional</li>
        </ul>
      </div>
    </main>
  </body>
</html>`;
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
