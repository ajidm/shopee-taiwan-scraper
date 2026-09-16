import type { Page } from "rebrowser-playwright";

const NAV_TIMEOUT_MS = 30_000;

/**
 * Technique — navigate to the exact target URL via a genuine, trusted click event instead
 * of page.goto() (a bare top-level navigation, closer to typing a URL directly). Validated
 * empirically: page.goto() straight to a product URL consistently triggered Shopee's
 * anti-bot wall in this project's testing, while navigating via an actual Playwright
 * .click() — which dispatches trusted CDP-level input events — on an injected link pointing
 * at the same exact URL succeeded, including for a storeId/dealId chosen deterministically
 * ahead of time (not discovered via organic browsing). This keeps the technique compatible
 * with the API's contract (an arbitrary, caller-specified product) while still producing a
 * "real click" navigation signal.
 *
 * Injects a plain, visually-hidden-but-clickable <a> element into the current page's DOM
 * and clicks it — the resulting navigation is otherwise identical to what a real user
 * clicking a real link on the page would produce.
 */
export async function navigateViaClick(page: Page, targetUrl: string): Promise<void> {
  const linkId = `injected-nav-link-${Date.now()}`;
  // This callback runs inside the browser (via page.evaluate), which has `document` — but
  // this file compiles under a Node-only tsconfig (no "dom" lib), so `document` is accessed
  // through a loosely-typed global rather than the DOM lib types.
  await page.evaluate(
    ({ href, id }) => {
      const doc = (globalThis as unknown as { document: { createElement: (tag: string) => any; body: { appendChild: (el: any) => void } } }).document;
      const a = doc.createElement("a");
      a.href = href;
      a.id = id;
      a.textContent = id;
      // Kept on-screen and clickable (not display:none) — some anti-bot heuristics treat
      // clicks on invisible/zero-size elements as suspicious, same as a headless browser
      // never finishing an image load.
      a.style.position = "fixed";
      a.style.top = "0";
      a.style.left = "0";
      a.style.zIndex = "2147483647";
      a.style.padding = "1px";
      doc.body.appendChild(a);
    },
    { href: targetUrl, id: linkId }
  );

  const link = page.locator(`#${linkId}`);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => undefined),
    link.click({ timeout: NAV_TIMEOUT_MS }),
  ]);
}

export function isClickNavigationEnabled(): boolean {
  return process.env.NAVIGATION_STRATEGY === "click";
}
