import type { Page } from "rebrowser-playwright";

const NAV_TIMEOUT_MS = 30_000;

/**
 * Technique — experimental method #7 in the experiment table: visit the Shopee homepage
 * first with a random idle delay before navigating to the product page, so the session
 * looks like organic browsing rather than a bot deep-linking straight into a product URL.
 *
 * Result from testing: did NOT prevent the traffic-verification wall on its own. Kept
 * available (NAVIGATION_STRATEGY=warmup) since it costs nothing to combine with other
 * techniques and roughly doubles bootstrap time, which may still matter in combination
 * with other unproven mitigations.
 */
export async function warmupHomepage(page: Page): Promise<void> {
  await page.goto("https://shopee.tw/", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.mouse.move(200 + Math.random() * 400, 200 + Math.random() * 300);
  await page.waitForTimeout(1500 + Math.random() * 2000);
}

export function isWarmupEnabled(): boolean {
  return process.env.NAVIGATION_STRATEGY === "warmup";
}
