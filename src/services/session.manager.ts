import { addExtra } from "playwright-extra";
import { chromium as rebrowserChromium } from "rebrowser-playwright";
import type { Browser, BrowserContext } from "rebrowser-playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { logger } from "../lib/logger";
import { AntiBotError } from "../lib/retry";
import { parseProxyForPlaywright, proxyManager } from "./proxy.manager";
import type { ShopeeProductParams, ShopeeSession } from "../types/shopee";

// rebrowser-playwright patches the CDP Runtime.enable leak that lets sites fingerprint
// Playwright-driven Chromium even with stealth plugins applied (see rebrowser-patches).
const chromium = addExtra(rebrowserChromium);
chromium.use(StealthPlugin());

const HEADLESS = process.env.HEADLESS !== "false";

// Manually staged Chrome-for-Testing build matching rebrowser-playwright's expected revision
// (staged by `npm run setup:browser`), since its bundled installer conflicts with the hoisted
// top-level "playwright" package. Override via env if the binary lives elsewhere.
const MAC_ARCH = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
const REBROWSER_CACHE_DIR = `${process.env.HOME}/Library/Caches/rebrowser-chromium-manual`;
const CHROME_EXECUTABLE_PATH =
  process.env.CHROME_EXECUTABLE_PATH ??
  (HEADLESS
    ? `${REBROWSER_CACHE_DIR}/chrome-headless-shell-${MAC_ARCH}/chrome-headless-shell`
    : `${REBROWSER_CACHE_DIR}/chrome-${MAC_ARCH}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);

const SESSION_TTL_MS = Number(process.env.SESSION_REFRESH_INTERVAL_MS ?? 10 * 60 * 1000);
const NAV_TIMEOUT_MS = 30_000;

// Experimental (PERSISTENT_PROFILE=true): reuse one long-lived browser profile (cookies,
// localStorage, IndexedDB) across all bootstraps instead of a fresh context every time —
// closer to how a real returning visitor looks, rather than a new incognito-like session
// per request. Off by default since it hasn't been confirmed to change outcomes and trades
// away the isolation ephemeral contexts give between different items' sessions.
const PERSISTENT_PROFILE = process.env.PERSISTENT_PROFILE === "true";
const PROFILE_DIR = `${process.env.HOME}/.mr-scraper-chrome-profile`;

// Headers actually used by Shopee's own web client when it calls get_pc/get_rw internally.
// Captured once via the real browser navigation, then reused verbatim for lightweight HTTP calls.
const PDP_REQUEST_URL_FRAGMENT = "/api/v4/pdp/get_";

function sessionKey(params: ShopeeProductParams): string {
  return `${params.storeId}:${params.dealId}`;
}

class SessionManager {
  private browser: Browser | null = null;
  private persistentContext: BrowserContext | null = null;
  // Shopee ties session validity closely to the specific product page that was navigated
  // to, so sessions are cached per storeId/dealId rather than shared globally.
  private cache = new Map<string, ShopeeSession>();
  private bootstrapping = new Map<string, Promise<ShopeeSession>>();

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    const proxyUrl = proxyManager.getProxy();
    // playwright-extra's bundled types resolve against the hoisted top-level playwright-core,
    // which is a structurally-near-identical but nominally distinct type from rebrowser-playwright's.
    this.browser = (await chromium.launch({
      headless: HEADLESS,
      executablePath: CHROME_EXECUTABLE_PATH,
      proxy: proxyUrl ? parseProxyForPlaywright(proxyUrl) : undefined,
    })) as unknown as Browser;
    logger.info({ usingProxy: Boolean(proxyUrl) }, "Playwright browser launched");
    return this.browser;
  }

  /** Returns a context to bootstrap in, plus whether the caller should close it afterwards. */
  private async getContext(): Promise<{ context: BrowserContext; ephemeral: boolean }> {
    if (PERSISTENT_PROFILE) {
      if (!this.persistentContext) {
        const proxyUrl = proxyManager.getProxy();
        this.persistentContext = (await chromium.launchPersistentContext(PROFILE_DIR, {
          headless: HEADLESS,
          executablePath: CHROME_EXECUTABLE_PATH,
          proxy: proxyUrl ? parseProxyForPlaywright(proxyUrl) : undefined,
          locale: "zh-TW",
          timezoneId: "Asia/Taipei",
          viewport: { width: 1366, height: 768 },
        })) as unknown as BrowserContext;
        logger.info({ usingProxy: Boolean(proxyUrl), profileDir: PROFILE_DIR }, "Persistent browser profile launched");
      }
      return { context: this.persistentContext, ephemeral: false };
    }

    const browser = await this.getBrowser();
    const context = await browser.newContext({
      locale: "zh-TW",
      timezoneId: "Asia/Taipei",
      viewport: { width: 1366, height: 768 },
    });
    return { context, ephemeral: true };
  }

  /** Returns a cached session for this exact product if still fresh, otherwise bootstraps a new one. */
  async getValidSession(params: ShopeeProductParams): Promise<ShopeeSession> {
    const key = sessionKey(params);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.capturedAt < SESSION_TTL_MS) {
      return cached;
    }
    return this.refresh(params);
  }

  /** Forces a fresh session bootstrap for this product (deduped per key). */
  async refresh(params: ShopeeProductParams): Promise<ShopeeSession> {
    const key = sessionKey(params);
    const inFlight = this.bootstrapping.get(key);
    if (inFlight) return inFlight;

    const promise = this.bootstrap(params).finally(() => {
      this.bootstrapping.delete(key);
    });
    this.bootstrapping.set(key, promise);
    return promise;
  }

  private async bootstrap(params: ShopeeProductParams): Promise<ShopeeSession> {
    logger.info({ params, persistentProfile: PERSISTENT_PROFILE }, "Bootstrapping fresh Shopee session via headless browser");
    let context: BrowserContext | null = null;
    let ephemeral = true;
    let page: Awaited<ReturnType<BrowserContext["newPage"]>> | null = null;

    try {
      ({ context, ephemeral } = await this.getContext());
      page = await context.newPage();
      const p = page;

      // Optional: skip loading images/fonts/stylesheets to save bandwidth on paid per-GB
      // proxies. Off by default — Shopee's frontend JS can observe that <img>/font elements
      // never fire their load event, which is itself an atypical, potentially bot-flagging
      // signal. Only enable this once IP/proxy quality is confirmed sufficient on its own.
      if (process.env.BLOCK_STATIC_ASSETS === "true") {
        const BLOCKED_RESOURCE_TYPES = new Set(["image", "stylesheet", "font", "media"]);
        await p.route("**/*", (route) => {
          if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
            return route.abort();
          }
          return route.continue();
        });
      }

      const captured: { headers: Record<string, string> | null; response: unknown | null } = {
        headers: null,
        response: null,
      };

      p.on("request", (request) => {
        if (request.url().includes(PDP_REQUEST_URL_FRAGMENT) && !captured.headers) {
          captured.headers = request.headers();
        }
      });

      // Preempt Shopee's first-visit language/region interstitial, which otherwise blocks
      // the real product page (and its get_pc/get_rw call) from ever loading.
      await context
        .addCookies([
          { name: "language", value: "zh-Hant", domain: ".shopee.tw", path: "/" },
          { name: "_lang", value: "zh-Hant", domain: ".shopee.tw", path: "/" },
        ])
        .catch(() => undefined);

      const url = `https://shopee.tw/a-i.${params.storeId}.${params.dealId}`;

      // Experimental (NAVIGATION_STRATEGY=warmup): visit the homepage first and idle briefly
      // before navigating to the product page, to look like an organic browsing session
      // rather than a bot deep-linking straight into a product URL. Off by default since
      // it roughly doubles bootstrap time and hasn't been confirmed to change outcomes.
      if (process.env.NAVIGATION_STRATEGY === "warmup") {
        await p.goto("https://shopee.tw/", { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await p.mouse.move(200 + Math.random() * 400, 200 + Math.random() * 300);
        await p.waitForTimeout(1500 + Math.random() * 2000);
      }

      await p.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

      // Best-effort: if a language-selection interstitial still appears, dismiss it by
      // clicking the Traditional Chinese / Taiwan option so the actual product page loads.
      await p
        .locator("text=/繁體中文|台灣|Taiwan/i")
        .first()
        .click({ timeout: 5000 })
        .catch(() => undefined);

      // Shopee's anti-bot system redirects suspected bot/velocity-flagged traffic here,
      // disguised as a login wall. Detect it immediately instead of waiting out the full
      // navigation timeout for a get_pc/get_rw call that will never come.
      if (p.url().includes("/verify/traffic")) {
        throw new AntiBotError(`Redirected to Shopee traffic verification wall: ${p.url()}`);
      }

      const pdpResponse = await p
        .waitForResponse((res) => res.url().includes(PDP_REQUEST_URL_FRAGMENT), {
          timeout: NAV_TIMEOUT_MS,
        })
        .catch(() => {
          logger.warn(
            { finalUrl: p.url() },
            "Timed out waiting for get_pc/get_rw network call during bootstrap"
          );
          return null;
        });

      if (pdpResponse) {
        captured.response = await pdpResponse.json().catch(() => null);
        logger.info(
          {
            params,
            capturedUrl: pdpResponse.url(),
            status: pdpResponse.status(),
            bodyPreview: JSON.stringify(captured.response).slice(0, 500),
          },
          "Captured PDP response during bootstrap"
        );
      }

      const cookies = await context.cookies();
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      if (!captured.headers) {
        throw new Error("Failed to capture Shopee PDP request headers during session bootstrap");
      }

      const session: ShopeeSession = {
        cookieHeader,
        headers: captured.headers,
        capturedAt: Date.now(),
        capturedResponse: captured.response,
      };
      this.cache.set(sessionKey(params), session);
      logger.info({ params }, "Shopee session bootstrap succeeded");
      return session;
    } finally {
      // Persistent contexts stay open across bootstraps (that's the point) — only close
      // the tab. Ephemeral contexts are closed entirely, tearing down their cookies too.
      if (ephemeral) {
        await context?.close().catch(() => undefined);
      } else {
        await page?.close().catch(() => undefined);
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.persistentContext?.close().catch(() => undefined);
    this.persistentContext = null;
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}

export const sessionManager = new SessionManager();
