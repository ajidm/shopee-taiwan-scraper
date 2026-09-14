import type { Page } from "rebrowser-playwright";

const BLOCKED_RESOURCE_TYPES = new Set(["image", "stylesheet", "font", "media"]);

/**
 * Technique #9 (Teknik Anti-Deteksi): skip loading images/fonts/stylesheets during
 * bootstrap. Cuts bandwidth per navigation ~60-80% (useful for per-GB proxy costs), but
 * off by default — Shopee's frontend JS can observe that <img>/font elements never fire
 * their `load` event, which is itself an atypical, potentially bot-flagging signal. Only
 * enable once IP/proxy quality is confirmed sufficient on its own.
 */
export async function blockStaticAssets(page: Page): Promise<void> {
  await page.route("**/*", (route) => {
    if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
      return route.abort();
    }
    return route.continue();
  });
}

export function isResourceBlockingEnabled(): boolean {
  return process.env.BLOCK_STATIC_ASSETS === "true";
}
