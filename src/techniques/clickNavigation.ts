import type { Page } from "rebrowser-playwright";

const NAV_TIMEOUT_MS = 30_000;

const SEARCH_INPUT_CANDIDATES = ["input[aria-label='Search']", "input[placeholder]", "form input", "input"];
const WARMUP_KEYWORDS = ["gadget murah", "aksesoris hp", "peralatan rumah", "fashion pria", "elektronik"];

/**
 * Technique — a short burst of genuine, organic interaction (typing a search keyword
 * character-by-character with jittered delay, submitting, waiting for real results to
 * render, scrolling) before the injected click. Added after live testing showed that a
 * "cold" injected click — landing on the homepage and immediately clicking an injected
 * link with zero prior interaction — was NOT sufficient on its own and still triggered the
 * anti-bot wall, unlike earlier tests where the click happened right after a real search
 * flow in the same page. This isolates a second variable beyond "click vs. goto()": the
 * click may need to occur within a session that already exhibits some human-like behavioral
 * signal, not just be a trusted click event in isolation. The search keyword is unrelated to
 * the actual target — this step's only purpose is generating organic-looking activity.
 */
export async function warmupWithOrganicSearch(page: Page): Promise<void> {
  let searchInput = null;
  for (const sel of SEARCH_INPUT_CANDIDATES) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
      searchInput = loc;
      break;
    }
  }
  if (!searchInput) return; // best-effort — don't fail the whole bootstrap over this

  const keyword = WARMUP_KEYWORDS[Math.floor(Math.random() * WARMUP_KEYWORDS.length)];
  await searchInput.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(300 + Math.random() * 400);
  await searchInput.pressSequentially(keyword, { delay: 70 + Math.random() * 60 }).catch(() => undefined);
  await page.waitForTimeout(400 + Math.random() * 400);
  await page.keyboard.press("Enter").catch(() => undefined);
  await page.waitForTimeout(2500 + Math.random() * 1500);
  await page.mouse.wheel(0, 300 + Math.random() * 300).catch(() => undefined);
  await page.waitForTimeout(500 + Math.random() * 500);
}

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
