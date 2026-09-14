/**
 * Ad-hoc tool (not part of the API): opens a real, visible browser using this project's
 * own anti-detection stack (rebrowser-playwright + stealth + proxy from .env) so you can
 * manually browse shopee.tw to find a fresh, never-tested product URL — using a properly
 * hardened browser instead of your regular Chrome, which has none of these mitigations.
 *
 * Usage:
 *   HEADLESS=false npx tsx scripts/browse.ts
 *
 * Leave the window open, browse normally, then copy the product URL you land on. The
 * script itself just keeps the browser alive until you press Ctrl+C in the terminal.
 */
import "dotenv/config";
import { getConfiguredBrowserEngine } from "../src/techniques/browserEngine";
import { parseProxyForPlaywright, proxyManager } from "../src/services/proxy.manager";

const HEADLESS = process.env.HEADLESS === "true"; // default false for this tool

const MAC_ARCH = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
const REBROWSER_CACHE_DIR = `${process.env.HOME}/Library/Caches/rebrowser-chromium-manual`;
// Same "||" (not "??") caveat as session.manager.ts: an empty-string env var must also
// fall through to the computed default.
const CHROME_EXECUTABLE_PATH =
  process.env.CHROME_EXECUTABLE_PATH ||
  (HEADLESS
    ? `${REBROWSER_CACHE_DIR}/chrome-headless-shell-${MAC_ARCH}/chrome-headless-shell`
    : `${REBROWSER_CACHE_DIR}/chrome-${MAC_ARCH}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);

async function main(): Promise<void> {
  const chromium = getConfiguredBrowserEngine();
  const proxyUrl = proxyManager.getProxy();

  console.log(`Launching browser (headless=${HEADLESS}, proxy=${proxyUrl ? "yes" : "no"})...`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: CHROME_EXECUTABLE_PATH,
    proxy: proxyUrl ? parseProxyForPlaywright(proxyUrl) : undefined,
  });

  const context = await browser.newContext({
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    viewport: { width: 1366, height: 768 },
  });

  const page = await context.newPage();
  await page.goto("https://shopee.tw/", { waitUntil: "domcontentloaded" }).catch((err) => {
    console.error("Navigation failed:", err.message);
  });

  console.log("Browser is open. Browse manually, then copy the product URL you land on.");
  console.log("Press Ctrl+C here when done.");

  // Keep the process alive until manually interrupted.
  await new Promise(() => undefined);
}

main().catch((err) => {
  console.error("browse.ts failed:", err);
  process.exit(1);
});
