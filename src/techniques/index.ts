/**
 * Registry of the 12 anti-detection techniques used in this project (see README.md
 * "Teknik Anti-Deteksi"). Each technique is implemented as a standalone module so
 * individual techniques can be reasoned about, tested, or swapped independently.
 *
 * Foundational techniques (always on — disabling them would degrade correctness, not
 * just detection risk, so they aren't exposed as toggles):
 *   1. Sesi & header dari browser asli   → session.manager.ts (bootstrap)
 *   4. Reuse sesi per-produk              → session.manager.ts (SessionManager.cache)
 *   5. Rate limiting alami                → lib/rateLimiter.ts
 *   6. Retry berbasis klasifikasi error   → lib/retry.ts + lib/errors.ts
 *   7. Proxy rotation (sticky/rotating)   → services/proxy.manager.ts
 *   10. Sticky proxy konsisten per-sesi   → session.manager.ts (session.proxyUrl)
 *
 * Selectable techniques (toggle independently via env var):
 *   2. Browser engine + stealth combo     → BROWSER_ENGINE=rebrowser|vanilla-stealth|vanilla
 *      see ./browserEngine.ts
 *   3. Penanganan interstitial bahasa     → always applied (cheap, no downside)
 *      see ./languageInterstitial.ts
 *   7*. Navigasi warm-up                  → NAVIGATION_STRATEGY=warmup|direct|click
 *      see ./navigationWarmup.ts, ./clickNavigation.ts
 *   8. Fallback endpoint get_pc→get_rw    → always applied (cheap, no downside)
 *      see ./fallbackEndpoint.ts
 *   9. Resource blocking                  → BLOCK_STATIC_ASSETS=true|false
 *      see ./resourceBlocking.ts
 *   11. In-browser fetch                  → IN_BROWSER_FETCH=true|false
 *      see session.manager.ts's fetchInBrowser()
 *   12. Circuit breaker per-produk        → always applied, cooldown via BLOCKED_COOLDOWN_MS
 *      see ./circuitBreaker.ts
 *   (bonus) Persistent browser profile    → PERSISTENT_PROFILE=true|false
 *      see session.manager.ts's getContext()
 */
export { createBrowserEngine, getConfiguredBrowserEngine, type BrowserEngine } from "./browserEngine";
export { applyLanguageCookies, dismissLanguageInterstitial } from "./languageInterstitial";
export { warmupHomepage, isWarmupEnabled } from "./navigationWarmup";
export { navigateViaClick, isClickNavigationEnabled } from "./clickNavigation";
export { blockStaticAssets, isResourceBlockingEnabled } from "./resourceBlocking";
export { isTrafficVerificationWall } from "./trafficWallDetector";
export { CircuitBreaker } from "./circuitBreaker";
export { withEndpointFallback } from "./fallbackEndpoint";
