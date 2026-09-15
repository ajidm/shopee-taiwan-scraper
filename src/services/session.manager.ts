import fs from "node:fs";
import type { Browser, BrowserContext } from "rebrowser-playwright";
import { logger } from "../lib/logger";
import { ScrapeError } from "../lib/errors";
import { parseProxyForPlaywright, proxyManager } from "./proxy.manager";
import {
  getConfiguredBrowserEngine,
  applyLanguageCookies,
  dismissLanguageInterstitial,
  warmupHomepage,
  isWarmupEnabled,
  blockStaticAssets,
  isResourceBlockingEnabled,
  isTrafficVerificationWall,
  CircuitBreaker,
} from "../techniques";
import type { ShopeeProductParams, ShopeeSession } from "../types/shopee";

const chromium = getConfiguredBrowserEngine();

const HEADLESS = process.env.HEADLESS !== "false";

// Manually staged Chrome-for-Testing build matching rebrowser-playwright's expected revision
// (staged by `npm run setup:browser`), since its bundled installer conflicts with the hoisted
// top-level "playwright" package. Override via env if the binary lives elsewhere.
const MAC_ARCH = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
const REBROWSER_CACHE_DIR = `${process.env.HOME}/Library/Caches/rebrowser-chromium-manual`;
// Note: "|| " (not "??") deliberately — an empty string in .env (CHROME_EXECUTABLE_PATH=
// with nothing after it, which dotenv sets to "" rather than undefined) must also fall
// through to the computed default, or Playwright silently ignores it and falls back to
// its own default browser resolution (which fails since that browser was never installed).
const CHROME_EXECUTABLE_PATH =
  process.env.CHROME_EXECUTABLE_PATH ||
  (HEADLESS
    ? `${REBROWSER_CACHE_DIR}/chrome-headless-shell-${MAC_ARCH}/chrome-headless-shell`
    : `${REBROWSER_CACHE_DIR}/chrome-${MAC_ARCH}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);

// Experimental: launch the user's actually-installed Chrome stable via Playwright's own
// "channel" resolution (e.g. BROWSER_CHANNEL=chrome) instead of a pinned Chrome-for-Testing
// binary. Different from pointing CHROME_EXECUTABLE_PATH at Chrome stable directly (method #8
// in README's experiment table, which crashed rebrowser-playwright's CDP patches due to a
// protocol-revision mismatch) — channel is Playwright's supported way to target a real browser
// install and carries its own compatibility handling. Only meaningful with
// BROWSER_ENGINE=vanilla or vanilla-stealth, since rebrowser's patches still assume the
// Chrome-for-Testing revision they were built against.
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || undefined;

// "patchright" ships/installs its own patched Chromium binary (in Playwright's standard
// ms-playwright cache, a different revision than rebrowser-playwright's pinned Chrome-for-
// Testing build) — never point it at CHROME_EXECUTABLE_PATH, let it resolve its own binary.
const USE_ENGINE_DEFAULT_BINARY = process.env.BROWSER_ENGINE === "patchright";

// Experimental (DEVICE_EMULATION=mobile): emulate a mobile web browser (iOS Safari UA,
// touch viewport) instead of desktop. Hypothesis from external research: Shopee's WAF may
// carry a higher trust bias toward mobile-web traffic than desktop — untested in this
// project prior to this option existing. See README "Batasan yang Diketahui".
const DEVICE_EMULATION = process.env.DEVICE_EMULATION === "mobile" ? "mobile" : "desktop";
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1";
const DEVICE_CONTEXT_OPTIONS =
  DEVICE_EMULATION === "mobile"
    ? { viewport: { width: 390, height: 844 }, userAgent: MOBILE_USER_AGENT, isMobile: true, hasTouch: true }
    : { viewport: { width: 1366, height: 768 } };

// Which Shopee region to scrape. Defaults to shopee.tw (this task's actual target); can be
// overridden for validation/testing against another region's platform (e.g. shopee.co.id),
// which shares the same get_pc/get_rw API shape and anti-bot behavior — see README.md.
const SHOPEE_DOMAIN = process.env.SHOPEE_DOMAIN || "shopee.tw";
const LOCALE_BY_DOMAIN: Record<string, { locale: string; timezoneId: string }> = {
  "shopee.tw": { locale: "zh-TW", timezoneId: "Asia/Taipei" },
  "shopee.co.id": { locale: "id-ID", timezoneId: "Asia/Jakarta" },
};
const { locale: SHOPEE_LOCALE, timezoneId: SHOPEE_TIMEZONE } = LOCALE_BY_DOMAIN[SHOPEE_DOMAIN] ?? {
  locale: "en-US",
  timezoneId: "UTC",
};

const SESSION_TTL_MS = Number(process.env.SESSION_REFRESH_INTERVAL_MS ?? 10 * 60 * 1000);
const NAV_TIMEOUT_MS = 30_000;

// Technique #12: after a session hits Shopee's traffic-verification wall, don't
// immediately try to bootstrap that same product again — back off for a cooldown period.
const BLOCKED_COOLDOWN_MS = Number(process.env.BLOCKED_COOLDOWN_MS ?? 5 * 60 * 1000);

// Bonus technique (PERSISTENT_PROFILE=true): reuse one long-lived browser profile (cookies,
// localStorage, IndexedDB) across all bootstraps instead of a fresh context every time —
// closer to how a real returning visitor looks, rather than a new incognito-like session
// per request. Off by default since it hasn't been confirmed to change outcomes and trades
// away the isolation ephemeral contexts give between different items' sessions.
const PERSISTENT_PROFILE = process.env.PERSISTENT_PROFILE === "true";
const PROFILE_DIR = `${process.env.HOME}/.mr-scraper-chrome-profile`;

// AUTH_MODE=login: bootstrap sessions from a previously-authenticated storage state (cookies +
// localStorage) instead of a blank guest context. The storage state file is produced by a
// one-time manual login run via `npm run login` (see scripts/login.ts) — this project never
// automates the login form itself (avoids scripting around OTP/captcha, and avoids handling
// raw credentials in code). Falls back to guest mode with a warning if the file is missing.
const AUTH_MODE = process.env.AUTH_MODE === "login" ? "login" : "guest";
const LOGIN_STORAGE_STATE_PATH = process.env.LOGIN_STORAGE_STATE_PATH || `${process.cwd()}/.auth/shopee-login-state.json`;

function getStorageStateOption(): string | undefined {
  if (AUTH_MODE !== "login") return undefined;
  if (fs.existsSync(LOGIN_STORAGE_STATE_PATH)) return LOGIN_STORAGE_STATE_PATH;
  logger.warn(
    { path: LOGIN_STORAGE_STATE_PATH },
    "AUTH_MODE=login but no storage state file found — falling back to guest session. Run `npm run login` first."
  );
  return undefined;
}

// Headers actually used by Shopee's own web client when it calls get_pc/get_rw internally.
// Captured once via the real browser navigation, then reused verbatim for lightweight HTTP calls.
const PDP_REQUEST_URL_FRAGMENT = "/api/v4/pdp/get_";

function sessionKey(params: ShopeeProductParams): string {
  return `${params.storeId}:${params.dealId}`;
}

class SessionManager {
  private browser: Browser | null = null;
  private persistentContext: BrowserContext | null = null;
  // Technique #4/#10: Shopee ties session validity closely to the specific product page
  // that was navigated to, so sessions are cached per storeId/dealId rather than shared
  // globally, and the proxy that built a session is pinned on it for reuse.
  private cache = new Map<string, ShopeeSession>();
  private bootstrapping = new Map<string, Promise<ShopeeSession>>();
  private circuitBreaker = new CircuitBreaker(BLOCKED_COOLDOWN_MS);

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    // playwright-extra's bundled types resolve against the hoisted top-level playwright-core,
    // which is a structurally-near-identical but nominally distinct type from rebrowser-playwright's.
    this.browser = (await chromium.launch({
      headless: HEADLESS,
      ...(BROWSER_CHANNEL
        ? { channel: BROWSER_CHANNEL }
        : USE_ENGINE_DEFAULT_BINARY
          ? {}
          : { executablePath: CHROME_EXECUTABLE_PATH }),
    })) as unknown as Browser;
    logger.info("Playwright browser launched");
    return this.browser;
  }

  /**
   * Returns a context to bootstrap in, the proxy URL it's using (if any), and whether the
   * caller should close it afterwards. Proxy is chosen fresh per call and applied at the
   * *context* level (not the shared browser instance) so that: (a) every session can get
   * its own proxy pick even though the browser process is shared, and (b) the exact proxy
   * used here can be recorded on the session and reused for its axios follow-up calls
   * (technique #10 — sticky proxy consistent per-session).
   */
  private async getContext(): Promise<{ context: BrowserContext; ephemeral: boolean; proxyUrl: string | null }> {
    if (PERSISTENT_PROFILE) {
      if (!this.persistentContext) {
        const proxyUrl = proxyManager.getProxy();
        // Note: launchPersistentContext has no storageState option (a persistent profile
        // already carries its own cookies/localStorage across launches via PROFILE_DIR) —
        // AUTH_MODE=login only applies to ephemeral contexts. To use a login session with a
        // persistent profile, log in manually once inside that profile via PERSISTENT_PROFILE.
        this.persistentContext = (await chromium.launchPersistentContext(PROFILE_DIR, {
          headless: HEADLESS,
          ...(BROWSER_CHANNEL
        ? { channel: BROWSER_CHANNEL }
        : USE_ENGINE_DEFAULT_BINARY
          ? {}
          : { executablePath: CHROME_EXECUTABLE_PATH }),
          proxy: proxyUrl ? parseProxyForPlaywright(proxyUrl) : undefined,
          locale: SHOPEE_LOCALE,
          timezoneId: SHOPEE_TIMEZONE,
          viewport: { width: 1366, height: 768 },
        })) as unknown as BrowserContext;
        logger.info(
          { usingProxy: Boolean(proxyUrl), profileDir: PROFILE_DIR, authMode: AUTH_MODE },
          "Persistent browser profile launched"
        );
      }
      // Persistent mode inherently pins one proxy for the profile's whole lifetime — there's
      // no per-session proxy to report back here beyond whatever was picked at launch.
      return { context: this.persistentContext, ephemeral: false, proxyUrl: null };
    }

    const proxyUrl = proxyManager.getProxy();
    const context = await this.createEphemeralContext(proxyUrl);
    return { context, ephemeral: true, proxyUrl };
  }

  private async createEphemeralContext(proxyUrl: string | null): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    return browser.newContext({
      locale: SHOPEE_LOCALE,
      timezoneId: SHOPEE_TIMEZONE,
      ...DEVICE_CONTEXT_OPTIONS,
      proxy: proxyUrl ? parseProxyForPlaywright(proxyUrl) : undefined,
      storageState: getStorageStateOption(),
    });
  }

  /**
   * Technique #11 (IN_BROWSER_FETCH=true): instead of replaying the captured session via
   * axios (a plain Node.js TLS/HTTP2 client), fetch get_pc/get_rw directly inside a real
   * Chromium page via page.evaluate(). This eliminates any TLS/HTTP2 fingerprint mismatch
   * between the browser that established the session and the client that reuses it — a
   * mismatch flagged as a likely contributor to the traffic-verification wall. Reuses the
   * session's own `proxyUrl` (not a fresh pick) so the exit IP matches what the cookies
   * were issued for.
   */
  async fetchInBrowser(url: string, session: ShopeeSession): Promise<{ status: number; body: string }> {
    let context: BrowserContext | null = null;
    let ephemeral = true;

    try {
      if (PERSISTENT_PROFILE) {
        const ctx = await this.getContext();
        context = ctx.context;
        ephemeral = false;
      } else {
        context = await this.createEphemeralContext(session.proxyUrl);
      }

      const cookies = session.cookieHeader
        .split(";")
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => {
          const idx = pair.indexOf("=");
          return { name: pair.slice(0, idx), value: pair.slice(idx + 1), domain: `.${SHOPEE_DOMAIN}`, path: "/" };
        })
        // A pair with no "=" (idx === -1) or an empty name (idx === 0) isn't a valid cookie
        // field for CDP's Storage.setCookies — surfaced by AUTH_MODE=login sessions, whose
        // cookie jar is large enough to occasionally include a malformed/empty entry.
        .filter((c) => c.name.length > 0);
      await context.addCookies(cookies).catch((err) => {
        logger.warn({ message: (err as Error).message, cookieCount: cookies.length }, "addCookies failed during in-browser fetch, continuing without them");
      });

      const page = await context.newPage();
      try {
        const result = await page.evaluate(
          async ({ fetchUrl, headers }) => {
            const res = await fetch(fetchUrl, { headers, credentials: "include" });
            return { status: res.status, body: await res.text() };
          },
          { fetchUrl: url, headers: session.headers }
        );
        return result;
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      if (ephemeral) {
        await context?.close().catch(() => undefined);
      }
    }
  }

  /** Returns a cached session for this exact product if still fresh, otherwise bootstraps a new one. */
  async getValidSession(params: ShopeeProductParams): Promise<ShopeeSession> {
    const key = sessionKey(params);
    this.circuitBreaker.assertNotBlocked(key);

    const cached = this.cache.get(key);
    if (cached && cached.status !== "blocked" && Date.now() - cached.capturedAt < SESSION_TTL_MS) {
      return cached;
    }
    return this.refresh(params);
  }

  /** Forces a fresh session bootstrap for this product (deduped per key). */
  async refresh(params: ShopeeProductParams): Promise<ShopeeSession> {
    const key = sessionKey(params);
    this.circuitBreaker.assertNotBlocked(key);

    const inFlight = this.bootstrapping.get(key);
    if (inFlight) return inFlight;

    const promise = this.bootstrap(params).finally(() => {
      this.bootstrapping.delete(key);
    });
    this.bootstrapping.set(key, promise);
    return promise;
  }

  /** Records a successful axios call against an already-bootstrapped session. */
  recordSuccess(params: ShopeeProductParams): void {
    const session = this.cache.get(sessionKey(params));
    if (session) session.successCount += 1;
  }

  /** Records a failed axios call and degrades the session's status if it keeps failing. */
  recordError(params: ShopeeProductParams): void {
    const session = this.cache.get(sessionKey(params));
    if (!session) return;
    session.errorCount += 1;
    if (session.status === "healthy" && session.errorCount >= 2) {
      session.status = "degraded";
    }
  }

  private async bootstrap(params: ShopeeProductParams): Promise<ShopeeSession> {
    const key = sessionKey(params);
    const previousRefreshCount = this.cache.get(key)?.refreshCount ?? 0;
    logger.info(
      { params, persistentProfile: PERSISTENT_PROFILE, authMode: AUTH_MODE, refreshCount: previousRefreshCount + 1 },
      "Bootstrapping fresh Shopee session via headless browser"
    );
    let context: BrowserContext | null = null;
    let ephemeral = true;
    let proxyUrl: string | null = null;
    let page: Awaited<ReturnType<BrowserContext["newPage"]>> | null = null;

    try {
      ({ context, ephemeral, proxyUrl } = await this.getContext());
      page = await context.newPage();
      const p = page;

      // Technique #9 (opsional)
      if (isResourceBlockingEnabled()) {
        await blockStaticAssets(p);
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

      // Technique #3: preempt the first-visit language/region interstitial.
      await applyLanguageCookies(context, SHOPEE_DOMAIN);

      const url = `https://${SHOPEE_DOMAIN}/a-i.${params.storeId}.${params.dealId}`;

      // Technique #7 (opsional)
      if (isWarmupEnabled()) {
        await warmupHomepage(p, SHOPEE_DOMAIN);
      }

      await p.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch((err) => {
        throw new ScrapeError("BROWSER_FAILURE", `page.goto failed: ${(err as Error).message}`);
      });

      // Technique #3 fallback: dismiss the interstitial if it still appeared.
      await dismissLanguageInterstitial(p);

      // Technique #12: detect the traffic-verification wall immediately instead of waiting
      // out the full navigation timeout for a get_pc/get_rw call that will never come, and
      // trip the circuit breaker right away so we don't immediately re-bootstrap it.
      if (isTrafficVerificationWall(p.url())) {
        this.circuitBreaker.trip(key);
        const existing = this.cache.get(key);
        if (existing) existing.status = "blocked";
        throw new ScrapeError("TRAFFIC_VERIFICATION", `Redirected to Shopee traffic verification wall: ${p.url()}`);
      }

      const pdpResponse = await p
        .waitForResponse((res) => res.url().includes(PDP_REQUEST_URL_FRAGMENT), {
          timeout: NAV_TIMEOUT_MS,
        })
        .catch(() => {
          logger.warn({ finalUrl: p.url() }, "Timed out waiting for get_pc/get_rw network call during bootstrap");
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
        throw new ScrapeError("BROWSER_FAILURE", "Failed to capture Shopee PDP request headers during session bootstrap");
      }

      const session: ShopeeSession = {
        cookieHeader,
        headers: captured.headers,
        capturedAt: Date.now(),
        capturedResponse: captured.response,
        proxyUrl,
        status: "healthy",
        successCount: 0,
        errorCount: 0,
        refreshCount: previousRefreshCount + 1,
      };
      this.cache.set(key, session);
      this.circuitBreaker.clear(key);
      logger.info({ params, proxyUrl }, "Shopee session bootstrap succeeded");
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
