import { addExtra } from "playwright-extra";
import { chromium as rebrowserChromium } from "rebrowser-playwright";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vanillaPlaywright = require("playwright") as { chromium: unknown };
import StealthPlugin from "puppeteer-extra-plugin-stealth";

export type BrowserEngine = "rebrowser" | "vanilla-stealth" | "vanilla";

/**
 * Technique #2 (Teknik Anti-Deteksi): choice of Playwright engine + stealth combination.
 * Kept swappable so each variable (CDP leak patch vs stealth plugin) can be isolated in
 * experiments, matching methods #1-#2 in the experiment table in README.md / .docs.
 *
 * - "rebrowser" (default, recommended): rebrowser-playwright (patches the CDP
 *   `Runtime.enable` leak) + stealth plugin. Method #2 — the only combination that has
 *   ever produced a real successful get_pc response in this project's testing.
 * - "vanilla-stealth": stock "playwright" package (no CDP patch) + stealth plugin —
 *   isolates whether the CDP patch specifically matters, independent of stealth.
 * - "vanilla": stock "playwright" package, no stealth at all — method #1, the original
 *   baseline that got detected on the very first request in this project's testing.
 *
 * Select via BROWSER_ENGINE env var.
 */
export function createBrowserEngine(engine: BrowserEngine = "rebrowser") {
  const base = engine === "rebrowser" ? rebrowserChromium : (vanillaPlaywright.chromium as typeof rebrowserChromium);
  const launcher = addExtra(base);
  if (engine !== "vanilla") {
    launcher.use(StealthPlugin());
  }
  return launcher;
}

export function getConfiguredBrowserEngine() {
  const engine = (process.env.BROWSER_ENGINE as BrowserEngine) ?? "rebrowser";
  return createBrowserEngine(engine);
}
