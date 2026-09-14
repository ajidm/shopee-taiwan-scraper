import type { BrowserContext, Page } from "rebrowser-playwright";

/**
 * Technique #3 (Teknik Anti-Deteksi): Shopee shows a language/region picker on a visitor's
 * first navigation, which blocks the real product page (and its get_pc/get_rw call) from
 * ever loading if left unhandled. Two-part mitigation: inject the language cookie
 * preemptively, and as a fallback, click through the interstitial if it still appears.
 */
export async function applyLanguageCookies(context: BrowserContext): Promise<void> {
  await context
    .addCookies([
      { name: "language", value: "zh-Hant", domain: ".shopee.tw", path: "/" },
      { name: "_lang", value: "zh-Hant", domain: ".shopee.tw", path: "/" },
    ])
    .catch(() => undefined);
}

export async function dismissLanguageInterstitial(page: Page): Promise<void> {
  await page
    .locator("text=/繁體中文|台灣|Taiwan/i")
    .first()
    .click({ timeout: 5000 })
    .catch(() => undefined);
}
