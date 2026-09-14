import { logger } from "../lib/logger";

interface ProxyState {
  url: string;
  failures: number;
  disabledUntil: number;
}

const FAILURE_THRESHOLD = 3;
const DISABLE_DURATION_MS = 5 * 60 * 1000;

export type ProxyMode = "sticky" | "rotating";

function loadList(envVar: string): ProxyState[] {
  const raw = process.env[envVar]?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => ({ url, failures: 0, disabledUntil: 0 }));
}

class ProxyManager {
  // "sticky" (PROXY_LIST): same exit IP reused for the lifetime of a session — needed
  // because Shopee's cookies/tokens are IP-bound, so a session's browser bootstrap and its
  // follow-up axios calls must go through the same IP or the session gets invalidated.
  // "rotating" (PROXY_ROTATING_LIST): a fresh IP on every proxy pick — useful for spreading
  // *independent* sessions/items across many IPs, but never mix mid-session or a single
  // page load's own sub-requests (HTML/JS/XHR) can end up split across different IPs.
  private lists: Record<ProxyMode, ProxyState[]> = {
    sticky: loadList("PROXY_LIST"),
    rotating: loadList("PROXY_ROTATING_LIST"),
  };
  private mode: ProxyMode = process.env.PROXY_MODE === "rotating" ? "rotating" : "sticky";
  private cursor = 0;

  constructor() {
    const active = this.lists[this.mode];
    if (active.length > 0) {
      logger.info({ mode: this.mode, count: active.length }, "Proxy manager initialized with proxy list");
    } else {
      logger.info({ mode: this.mode }, "Proxy manager initialized in no-op mode (no proxies configured for this mode)");
    }
  }

  private get proxies(): ProxyState[] {
    return this.lists[this.mode];
  }

  hasProxies(): boolean {
    return this.proxies.length > 0;
  }

  /** Returns a proxy URL to use, or null when running without a proxy (direct connection). */
  getProxy(): string | null {
    if (this.proxies.length === 0) return null;

    const now = Date.now();
    for (let i = 0; i < this.proxies.length; i++) {
      const idx = (this.cursor + i) % this.proxies.length;
      const candidate = this.proxies[idx];
      if (candidate.disabledUntil <= now) {
        this.cursor = (idx + 1) % this.proxies.length;
        return candidate.url;
      }
    }

    logger.warn("All proxies currently disabled due to failures; falling back to direct connection");
    return null;
  }

  reportFailure(url: string): void {
    const entry = this.proxies.find((p) => p.url === url);
    if (!entry) return;
    entry.failures += 1;
    if (entry.failures >= FAILURE_THRESHOLD) {
      entry.disabledUntil = Date.now() + DISABLE_DURATION_MS;
      logger.warn({ url }, "Proxy disabled temporarily after repeated failures");
    }
  }

  reportSuccess(url: string): void {
    const entry = this.proxies.find((p) => p.url === url);
    if (!entry) return;
    entry.failures = 0;
  }
}

export const proxyManager = new ProxyManager();

/**
 * Playwright's browser-level `proxy` launch option requires credentials as separate
 * `username`/`password` fields — unlike axios/https-proxy-agent, it does NOT parse
 * `user:pass@` embedded in the server URL, and silently hangs waiting for proxy auth
 * instead of failing fast if you pass it that way.
 */
export function parseProxyForPlaywright(proxyUrl: string): {
  server: string;
  username?: string;
  password?: string;
} {
  const parsed = new URL(proxyUrl);
  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  parsed.username = "";
  parsed.password = "";
  return { server: parsed.toString().replace(/\/$/, ""), username, password };
}
