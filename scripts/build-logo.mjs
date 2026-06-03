/**
 * Render scripts/logo.html into scripts/logo.png at 1024×1024 with the
 * Canopee display face. Use the output as the source for `pnpm tauri icon`,
 * which generates every platform variant (macOS .icns, Windows .ico,
 * various PNGs) into src-tauri/icons/.
 *
 * Usage:
 *   node scripts/build-logo.mjs
 *   pnpm tauri icon scripts/logo.png
 *   pnpm tauri:build
 */

import puppeteer from "puppeteer";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = `file://${resolve(__dirname, "logo.html")}`;
const outPath = resolve(__dirname, "logo.png");

console.log(`[logo] rendering ${htmlPath} → ${outPath}`);

const browser = await puppeteer.launch({
  // Puppeteer 25 default channel is headless=new which renders text more
  // crisply than the legacy mode.
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setViewport({
    width: 1024,
    height: 1024,
    deviceScaleFactor: 1,
  });
  await page.goto(htmlPath, { waitUntil: "domcontentloaded" });
  // Make sure Canopee is loaded before we snap.
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
  });
  // Tiny settle so layout fully reflows after font swap.
  await new Promise((r) => setTimeout(r, 100));
  await page.screenshot({
    path: outPath,
    type: "png",
    omitBackground: false,
    clip: { x: 0, y: 0, width: 1024, height: 1024 },
  });
  console.log("[logo] wrote", outPath);
} finally {
  await browser.close();
}
