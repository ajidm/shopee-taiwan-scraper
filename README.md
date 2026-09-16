# Shopee Taiwan Scraper API

*[Versi Bahasa Indonesia](README.id.md)*

A TypeScript REST API that fetches Shopee Taiwan product-detail data (`get_pc`/`get_rw`) using a **hybrid** approach: a headless browser (Playwright + stealth) is used sparingly to build a valid session/cookie/header set, while the bulk of product requests are served by a lightweight HTTP client (axios) that reuses that session — balancing anti-bot resilience with scalability.

> **Status:** Code is complete, type-check/lint/build are clean, and it **has proven to work end-to-end once**, fetching a full, real product payload matching the `get_pc` schema. After that, the two sample items used repeatedly during development tripped Shopee's anti-bot system (`/verify/traffic/error`, code `90309999`), which turned out to be persistent across IP/network/proxy (see [Methods & Experiments Tried](#methods--experiments-tried) — 9 approaches documented). Following that, two independent analysis reviews (see [External Analysis & Further Fixes](#external-analysis--further-fixes)) produced further improvements: granular error classification, per-product circuit breaker, sticky-proxy-per-session (a real bug fixed), in-browser fetch to eliminate TLS mismatch, and a ramp-up load test. The architecture already implements standard practices for high-quality scraping; a consistent 200+ item volume test would most likely require items/products that haven't been "burned" by repeated testing and/or a premium residential proxy.

## Table of Contents

- [Architecture](#architecture)
- [Setup & Running Locally](#setup--running-locally)
- [Proxy Configuration](#proxy-configuration)
- [API Usage](#api-usage)
- [Anti-Detection Techniques](#anti-detection-techniques)
- [Guest vs Login Mode (`AUTH_MODE`)](#guest-vs-login-mode-auth_mode)
- [Load Test / Stability Test](#load-test--stability-test)
- [Hosting via Ngrok](#hosting-via-ngrok)
- [Methods & Experiments Tried](#methods--experiments-tried)
- [External Analysis & Further Fixes](#external-analysis--further-fixes)
- [Known Limitations](#known-limitations)

## Architecture

```text
Client → GET /shopee?storeId=&dealId=
           │
           ▼
   validateQuery middleware
           │
           ▼
   shopee.client.ts ── rateLimiter (concurrency + jitter)
           │                 │
           │                 ▼
           │           retry.ts (backoff; anti-bot → refresh session)
           │
           ├─→ session.manager.ts (headless Playwright, stealth plugin)
           │      → opens https://shopee.tw/a-i.{storeId}.{dealId}
           │      → captures the browser's real cookies & headers from the get_pc/get_rw request
           │      → caches the session (TTL, default 10 minutes)
           │
           └─→ axios GET to api/v4/pdp/get_pc (fallback get_rw)
                  using the cookies & headers captured from the browser
                  + optional proxy (proxy.manager.ts)
                  → returns the original JSON, passthrough with no transformation
```

Folder structure:

```text
src/
  server.ts               Express app + graceful shutdown
  routes/shopee.route.ts  GET /shopee
  services/
    session.manager.ts    Session bootstrap & caching via Playwright
    shopee.client.ts      HTTP client for get_pc/get_rw
    proxy.manager.ts       Proxy rotation (pluggable, no-op by default)
  lib/
    rateLimiter.ts         Concurrency limiter + jitter delay
    retry.ts               Per-error-type retry, different policy per ScrapeErrorType
    errors.ts              ScrapeError + 9 classified error types
    logger.ts              Structured logging (pino)
  middleware/
    validateQuery.ts
    errorHandler.ts
  types/shopee.ts          ShopeeSession, ShopeeProductParams types
  techniques/              12 anti-detection techniques as standalone modules (see index.ts)
scripts/
  setup-browser.js         Downloads & stages Chrome for Testing for rebrowser-playwright
test/
  loadtest.ts              Volume & stability test script
  targets.example.json     Example storeId/dealId list
```

## Setup & Running Locally

Prerequisite: Node.js ≥ 20.

```bash
npm install
npm run setup:browser             # download & stage Chrome for Testing for rebrowser-playwright (macOS)
cp .env.example .env              # then fill in PROXY_LIST if you have a proxy (see below)
npm run dev                       # runs at http://localhost:3000
```

> Note: this project uses `rebrowser-playwright` (not plain `playwright`) so the automated Chromium isn't easily detected via Chrome DevTools Protocol traces. Its bundled installer (`npx playwright install`) conflicts with the hoisted `playwright` package, so `npm run setup:browser` downloads the matching Chrome for Testing build directly and stages it at `~/Library/Caches/rebrowser-chromium-manual` (macOS only — for other platforms, install manually and set `CHROME_EXECUTABLE_PATH` in `.env`).

Check the server is alive:

```bash
curl http://localhost:3000/health
```

Production build:

```bash
npm run build
npm start
```

## Proxy Configuration

A proxy is **not required** to run the API (default: requests go out directly from your machine's/ngrok's IP), but is strongly recommended for high volume & to reduce rate-limit/block risk from Shopee. There are two modes:

```bash
PROXY_MODE=sticky              # default
PROXY_LIST=http://user:pass@host1:port,http://user:pass@host2:port

# or
PROXY_MODE=rotating
PROXY_ROTATING_LIST=http://user:pass@host1:port,http://user:pass@host2:port
```

- **`sticky`** (default): the same IP is kept for the entire lifetime of one session (Playwright bootstrap + subsequent axios requests to the same product) — this is **mandatory**, since Shopee's cookies/tokens are bound to the IP; if the IP changes mid-session, the session becomes invalid.
- **`rotating`**: a new IP every time `proxyManager.getProxy()` is called — suitable for spreading load across **different** sessions/products, but don't use it if your provider needs per-session IP continuity.
- Leave `PROXY_LIST`/`PROXY_ROTATING_LIST` empty to run without a proxy.
- Multiple comma-separated proxies are used round-robin within the active mode; a proxy that fails repeatedly (≥3x) is automatically disabled temporarily (5 minutes) then retried.
- Recommended residential proxy sources with Taiwan geo-targeting: [DataImpulse](https://dataimpulse.com), [IPRoyal](https://iproyal.com). **Important:** for providers that support sticky/rotating via different ports (e.g. DataImpulse: port `10000` = sticky, `823` = rotating), make sure the port in your proxy URL matches the `PROXY_MODE` you chose.

## API Usage

### `GET /shopee?storeId={storeId}&dealId={dealId}`

Fetches and returns Shopee's **original response** for `get_pc` (fallback to `get_rw` if `get_pc` doesn't return a valid item).

Example:

```bash
curl "http://localhost:3000/shopee?storeId=178926468&dealId=21448123549"
```

Success response (200): JSON identical to Shopee's `get_pc` structure (see `.docs/get_pc.response_example.txt` for the full schema reference — `item`, `shop_detailed`, `product_shipping`, `product_review`, etc.).

Failure responses:

- `400` — `storeId`/`dealId` invalid (must be numeric).
- `502` — failed to fetch data from Shopee after all retries were exhausted (see the `message` field for the cause).

### `GET /health`

Simple health check, returns `{ "status": "ok" }`.

## Anti-Detection Techniques

Most of the selectable techniques (as opposed to the core architecture) are implemented as standalone modules in `src/techniques/` (`browserEngine.ts`, `languageInterstitial.ts`, `navigationWarmup.ts`, `resourceBlocking.ts`, `trafficWallDetector.ts`, `circuitBreaker.ts`, `fallbackEndpoint.ts`) — see `src/techniques/index.ts` for the full list & which env var enables each technique. This makes it easy to combine/isolate techniques for further experiments without touching `session.manager.ts`'s core logic.

1. **Session & headers from a real browser, not manually forged.** `session.manager.ts` opens a product page via Playwright (with `puppeteer-extra-plugin-stealth`, which masks common automation indicators like `navigator.webdriver`, plugin/permissions inconsistencies, etc.) and intercepts (`page.on("request")`) the headers **actually sent by the browser** to the `get_pc`/`get_rw` endpoint, including Shopee's dynamic signatures (e.g. `af-ac-enc-dat`, `x-api-source`) that are hard to forge manually. This avoids needing to statically reverse-engineer Shopee's signature algorithm, which would go stale whenever Shopee changes its implementation.
2. **`rebrowser-playwright` instead of standard Playwright (`BROWSER_ENGINE`, see `src/techniques/browserEngine.ts`).** Regular Playwright (even with a stealth plugin) still leaves traces detectable through how it uses the Chrome DevTools Protocol (e.g. the `Runtime.enable` leak) — a well-known detection vector not covered by generic stealth plugins. `rebrowser-playwright` is a Playwright fork specifically patched to remove that CDP trace. 4 combinations are selectable: `rebrowser` (default), `vanilla-stealth` (plain Playwright + stealth, to isolate the CDP-patch variable), `vanilla` (the original baseline that failed), or `patchright` (see the research notes in [Known Limitations](#known-limitations) — a more thorough CDP patch than `rebrowser-playwright`, which still doesn't get past Shopee's current detection).
3. **Language-selection interstitial handling.** The first navigation to `shopee.tw` can show a language/region picker for new visitors, which if left unhandled blocks the real product page (and `get_pc`) from ever loading. The code pre-injects a language-preference cookie, and as a fallback tries to click the Traditional Chinese/Taiwan option if the popup still appears.
4. **Per-product session reuse, not browser-per-request.** Sessions (cookies + headers) are cached **per `storeId`+`dealId`** with a TTL (`SESSION_REFRESH_INTERVAL_MS`, default 10 minutes) and reused for subsequent requests to the same product via the lightweight HTTP client (axios). Testing showed Shopee's session is tightly bound to the specific product page navigated to (likely via a cross-validated referer/token), so sessions are **not** shared across different products — each new product still needs one Playwright navigation to bootstrap a session, but repeat requests to the same product within the TTL stay lightweight via axios.
5. **Natural rate limiting.** `rateLimiter.ts` caps concurrency (default 4 parallel requests) and adds a random delay (jitter, default 300–1500ms) between requests, so the request timing pattern doesn't look mechanically like a bot flood.
6. **Retry based on error classification (`src/lib/errors.ts`).** Every failure is normalized into one of 9 types (`NETWORK_ERROR`, `TIMEOUT`, `HTTP_403`, `HTTP_429`, `TRAFFIC_VERIFICATION`, `INVALID_RESPONSE`, `SESSION_EXPIRED`, `PROXY_FAILURE`, `BROWSER_FAILURE`), each with its own retry policy in `retry.ts`. **Important:** `TRAFFIC_VERIFICATION` is deliberately given **0 retries** — refreshing the session then retrying after hitting the anti-bot wall is suspected to actually **worsen** the risk/velocity score rather than fix anything, per external analysis findings (see below). Instead, the session & product are immediately marked `blocked` with a cooldown (`BLOCKED_COOLDOWN_MS`, default 5 minutes) before being retried.
7. **Proxy rotation (optional, pluggable).** `proxy.manager.ts` supports a round-robin proxy list, with frequently-failing proxies automatically quarantined temporarily — reducing dependence on a single outbound IP.
8. **Endpoint fallback.** If `get_pc` doesn't return an item (null/error), `get_rw` is automatically tried as a backup.
9. **Resource blocking in Playwright (optional, `BLOCK_STATIC_ASSETS=true`).** Since only the `get_pc`/`get_rw` JSON is needed, images/fonts/stylesheets can be blocked during bootstrap to cut bandwidth ~60-80% (useful for per-GB proxy costs). **Default: off** — `<img>`/font elements that never finish loading could themselves be a detection signal for Shopee's anti-bot JS (a real human browser always finishes loading them), so only enable this once IP/proxy quality has already proven good on its own.
10. **Consistent sticky proxy per session (bug fix).** Previously, the browser (Playwright) and the HTTP client (axios) each independently called `proxyManager.getProxy()` — with >1 proxy in `PROXY_LIST`, both could end up going out through **different IPs** within the same session, even though Shopee's cookie/token is bound to the IP. The proxy is now picked **once per bootstrap** and stored in `session.proxyUrl`, then reused consistently by axios (or the in-browser fetch) for that session.
11. **In-browser fetch (on by default, `IN_BROWSER_FETCH=true`).** Instead of replaying via axios (Node.js's TLS/HTTP2 stack — potentially mismatched with the Chromium fingerprint that issued the session), `get_pc`/`get_rw` is called directly via `page.evaluate(fetch(...))` inside the real Chromium context. This eliminates the TLS/HTTP2 fingerprint variable entirely for repeat requests, not just the first one. **Why this became the default (no longer optional):** public technical documentation on Shopee's anti-fraud mechanism (the `x-sap-ri` signature header, etc.) states the per-request signature is bound to a device-side *sequence counter* that only increments correctly when the fetch is executed by the same browser instance holding the session — replaying via `axios` outside the browser, even with genuinely captured headers, risks being seen as "out-of-sequence" once that counter desyncs. This matches the pattern observed throughout this project: the first request (from the browser) often succeeds, while the subsequent replay (via axios) is what starts failing. Set `IN_BROWSER_FETCH=false` to fall back to axios (faster, but per the analysis above, more prone to failing after the first request in a session).
12. **Per-product circuit breaker.** Once a product hits `/verify/traffic/error`, the session & product are immediately marked `blocked` and cooled down (`BLOCKED_COOLDOWN_MS`) — the next request to the same product fails fast without opening a new browser, instead of continuing to hammer an already-flagged product.

### How to Choose/Combine Techniques

Techniques #2, #7, #9, #11, and the bonus persistent-profile feature are **optional** and selected via env vars — combine them as needed for experiments. The other techniques (#1, #3-6, #8, #10, #12) are always active (part of the core architecture).

| Env Var | Value | Technique | Default |
|---|---|---|---|
| `BROWSER_ENGINE` | `rebrowser` \| `vanilla-stealth` \| `vanilla` \| `patchright` | #2 — browser engine + stealth | `rebrowser` |
| `NAVIGATION_STRATEGY` | `direct` \| `warmup` | #7 — homepage warm-up navigation | `direct` |
| `BLOCK_STATIC_ASSETS` | `true` \| `false` | #9 — resource blocking | `false` |
| `IN_BROWSER_FETCH` | `true` \| `false` | #11 — fetch via `page.evaluate()` | `true` |
| `PERSISTENT_PROFILE` | `true` \| `false` | bonus — persistent browser profile | `false` |
| `BLOCKED_COOLDOWN_MS` | number (ms) | #12 — circuit breaker cooldown duration | `300000` (5 min) |
| `SESSION_REFRESH_INTERVAL_MS` | number (ms) | #4 — per-product session cache TTL | `600000` (10 min) |

**Usage examples** (as an env var prefix before the command, or set in `.env`):

```bash
# Default: rebrowser + in-browser fetch, no warm-up (production recommendation)
npm run dev

# Isolate a variable: test whether rebrowser's CDP patch matters, without the bundled stealth plugin
BROWSER_ENGINE=vanilla-stealth npm run dev

# Disable in-browser fetch, fall back to axios (faster, but more prone to failing after the first request per session)
IN_BROWSER_FETCH=false npm run dev

# "Most defensive" combo: navigation warm-up + in-browser fetch (default) + persistent profile
NAVIGATION_STRATEGY=warmup PERSISTENT_PROFILE=true npm run dev

# Test the old baseline (method #1 in the experiment table) for comparison — usually fails fast
BROWSER_ENGINE=vanilla npm run dev

# Save proxy bandwidth (resource blocking) on top of the default in-browser fetch
BLOCK_STATIC_ASSETS=true npm run dev

# Shorten the circuit breaker cooldown to 1 minute for quick testing (don't use in production)
BLOCKED_COOLDOWN_MS=60000 npm run dev
```

All combinations can also be set permanently in `.env` (see `.env.example` for the full list + explanation of each option). For a programmatic map of technique → code file → env var, see the comments in `src/techniques/index.ts`.

## Guest vs Login Mode (`AUTH_MODE`)

Per the findings in the [Known Limitations](#known-limitations) section, Shopee currently restricts **guest/anonymous** access broadly — not just for automated scrapers, but also confirmed via manual human browsing. To accommodate both scenarios without changing the task's original scope assumption (guest-only stays the default), two modes are available via `AUTH_MODE`:

| `AUTH_MODE` | Behavior | Default |
|---|---|---|
| `guest` | Session bootstraps from an empty/anonymous browser context — matching the task's original scope (public scraping, no account). | ✅ Default |
| `login` | Session bootstraps by loading a *storage state* (cookies + localStorage) from a previously-completed login. | — |

**Important: the login form is never automated by this code.** The login process (including any OTP/captcha Shopee asks for) is always done by a human manually, once, via a real browser opened by `npm run login` — never auto-filled by a script. This reduces account risk (no credential-stuffing/scripted-login that could trigger additional detection) and avoids needing to store a raw password anywhere in the code/`.env`.

**How to use login mode:**

```bash
# 1. One-time manual login (opens a real browser, you log in yourself including OTP/captcha)
npm run login
# or target a different region:
SHOPEE_DOMAIN=shopee.co.id npm run login

# Once login is complete in the opened browser, press Enter in the terminal.
# The session (cookies + localStorage) is saved to .auth/shopee-login-state.json (gitignored).

# 2. Run the server with the logged-in session
AUTH_MODE=login npm run dev
```

If `AUTH_MODE=login` is set but the storage state file doesn't exist yet (never ran `npm run login`), the system automatically falls back to `guest` mode with a warning log — it doesn't crash.

**Risk & scope note:** `login` mode is provided for **validation/research purposes** (e.g. isolating whether guest vs authenticated access affects `get_pc`'s outcome), not as the default recommendation for a high-volume production run — a personal account used for 200+ automated requests in a short time risks getting flagged/restricted by Shopee, regardless of whatever anti-detection technique is used. The `.auth/shopee-login-state.json` file contains live session cookies — treat it like a password, never commit it (it's already in `.gitignore`).

## Load Test / Stability Test

To meet the 200+ items with <10% error rate criteria, sustained over a continuous test:

```bash
# Run the server in a separate terminal: npm run dev

# Test 200 requests (default), concurrency 4
npm run loadtest

# Duration-based test (e.g. 60 minutes) instead of a fixed count
DURATION_MINUTES=60 npm run loadtest

# Graduated ramp-up (RECOMMENDED): 1 → 5 → 10 → 25 → 50 → 100 → 200 requests,
# automatically stops if a stage's error rate exceeds 50% (avoid piling more
# load onto a target that's already clearly failing)
RAMP_UP=true npm run loadtest
RAMP_UP=true RAMP_STAGES=1,5,10,25,50,100,200 RAMP_PAUSE_MS=5000 npm run loadtest

# Adjust concurrency / total requests
TOTAL_REQUESTS=250 CONCURRENCY=5 npm run loadtest
```

The script reads targets from `test/targets.json` (falls back to `test/targets.example.json` if it doesn't exist). **For a real 200+ item test, create `test/targets.json` with 200+ distinct `{storeId, dealId}` pairs** — the example list only has 2 products for a quick demo.

Output is a summary: total requests, successes/failures, error rate, average latency, and PASS/FAIL status against the criteria.

## Hosting via Ngrok

```bash
# Terminal 1
npm run build && npm start
# or: npm run dev

# Terminal 2
ngrok http 3000
```

Copy the public URL from Ngrok (e.g. `https://xxxx.ngrok-free.app`) and use it as the base URL, e.g.:

```text
https://xxxx.ngrok-free.app/shopee?storeId=178926468&dealId=21448123549
```

## Methods & Experiments Tried

During development, the example endpoints (`storeId=178926468&dealId=21448123549` and `storeId=3543467&dealId=18904813090`) hit persistent rate/anti-bot issues after repeated volume testing. The table below documents every approach tried to address it, so the reviewer has a full picture of the debugging process and each method's trade-offs — **not just** the final working solution.

| # | Method | How to enable | Result | Notes |
|---|--------|--------------------|-------|---------|
| 1 | Standard Playwright + stealth plugin | (initial, before migrating to rebrowser) | ❌ Detected from the first request (`error: 90309999`) | Suspected CDP `Runtime.enable` leak |
| 2 | `rebrowser-playwright` + stealth (current default) | Default | ✅ Succeeded once early on (single request) — ❌ consistently failed after high volume | The base architecture used |
| 3 | Per-item session (not global) | Default | ✅ Fixed a bug where sessions were shared across different products | A real bug, permanently fixed |
| 4 | Resource blocking (skip image/font/css) | `BLOCK_STATIC_ASSETS=true` | ⚠️ Not tested in isolation — could be a new detection signal itself | Default: off |
| 5 | Free datacenter proxy (Webshare, public) | `PROXY_LIST` | ❌ Mostly dead/timing out | Free proxy quality isn't reliable |
| 6 | Residential + Taiwan-geo proxy (DataImpulse) | `PROXY_LIST` + `PROXY_MODE=sticky` | ❌ Still hit `90309999`, even from a genuine TW IP & plain `curl` | Proves it's not purely about IP/reputation |
| 7 | Staged navigation (warm-up: homepage first, delay, then product) | `NAVIGATION_STRATEGY=warmup` | ❌ Still hit `90309999` on the first request | Organic navigation pattern alone isn't enough |
| 8 | Real installed Chrome (not the bundled Chrome-for-Testing) | `CHROME_EXECUTABLE_PATH=/Applications/Google Chrome.app/...` | ❌ Failed — not an anti-bot issue, but an internal crash (`session closed`) | `rebrowser-playwright`'s CDP patch isn't compatible with the stable Chrome protocol version; it only works with the bundled Chrome-for-Testing revision |
| 9 | Persistent browser profile (cookies survive across bootstraps) | `PERSISTENT_PROFILE=true` | ❌ Failed due to a library bug — not an anti-bot issue | `playwright-extra`'s `launchPersistentContext` ignores the custom `executablePath` option, falling back to an old default path that doesn't exist on the system. This feature's code remains in `session.manager.ts` for reference, but couldn't be fully tested due to this bug |

**Interim conclusion (since corrected, see the note below):** the combined evidence (plain curl with no fingerprint gets the same code; a genuine Taiwan IP still fails; the homepage SPA explicitly loads a `pcmall-anticrawler` module) indicated Shopee TW has a mature anti-scraping system that scores risk based on a combination of many signals — but **importantly**: most of the experiments above changed **more than one variable at once** (e.g. method #6 changed the proxy and the network simultaneously), so a conclusion like "IP doesn't matter" wasn't actually tested rigorously with single-variable isolation. See the next section for further analysis that corrects this.

## External Analysis & Further Fixes

Two independent analyses were run against the findings above, each taking a different, complementary angle:

**Analysis 1 — a specific hypothesis (TLS/HTTP2 fingerprint mismatch):** once Playwright (Chromium's TLS fingerprint) issues the cookie/session, the subsequent axios request (Node.js/OpenSSL's TLS fingerprint) could be treated by Shopee as "session hijacking" because the transport fingerprint changes mid-session. **Validity note:** this hypothesis doesn't fully match our data — in some logs, the `90309999` code appeared **directly from the native browser response capture during bootstrap**, not just from an axios replay — so a TLS mismatch is likely one contributing factor, not the sole cause.

**Analysis 2 — a methodological critique:** pointed out that many of our experiments changed >1 variable at once (weakening the strength of the conclusions), and more importantly — **our own retry pattern (`refresh session → retry → refresh again → retry again`) was suspected of worsening the risk/velocity score**, not fixing it. Also flagged the initial load test (`20 requests, concurrency 4`, immediately, with no gradual ramp-up) as a likely direct trigger for the sample items getting flagged.

### Fixes implemented from these two analyses

| Source | Recommendation | Implementation |
|---|---|---|
| Analysis 1 | In-browser fetch via `page.evaluate()` | `IN_BROWSER_FETCH=true` (now the default) — see item #11 in Anti-Detection Techniques |
| Analysis 2 | Granular error classification instead of one generic error | `src/lib/errors.ts` — 9 error types each with its own retry policy |
| Analysis 2 | Don't aggressively retry `TRAFFIC_VERIFICATION` | `retry.ts` — `maxRetries: 0` for this type, fail fast + cooldown |
| Analysis 2 | Per-product/session circuit breaker | `session.manager.ts` — `blocked` status + `BLOCKED_COOLDOWN_MS` |
| Analysis 2 | Sticky proxy must be consistent throughout a session (not per-request) | A real bug found & fixed — see item #10 in Anti-Detection Techniques |
| Analysis 2 | Gradually ramp up load tests (1→5→10→...→200), not straight to high volume | `test/loadtest.ts` — `RAMP_UP=true` mode |
| Analysis 2 | Observability: `requestId`, `sessionAgeMs`, `latencyMs`, `responseHasItem`, etc. | Added to `shopee.client.ts` logs |

### Recommendations not implemented (and why)

- **`tls-client` (TLS impersonation via a native Go binary)**. Not implemented because `IN_BROWSER_FETCH` achieves the same goal (eliminating the TLS mismatch) without an extra native dependency that would significantly increase deployment complexity.
- **Full single-variable isolation experiments** (a hypothesis matrix: request replay, signature lifetime, per-product binding, device vs. IP, endpoint comparison) — this list of experiments is very valuable, but each one needs a genuinely fresh product + live access to Shopee to run correctly (something already very limited in this session due to prior testing volume). The new retry/error/circuit-breaker framework above was designed so these experiments **can** be run more safely (without worsening the risk score) whenever access to a new product is available.

### Additional note: public research on Shopee's signature mechanism

To validate the `IN_BROWSER_FETCH` direction, public technical documentation discussing the structure of Shopee's anti-fraud headers was also reviewed (`af-ac-enc-sz-token` as a session-level constant, `x-sap-ri` as a per-request signature). Findings relevant to our design:

- The per-request signature is reportedly bound to a **device-side sequence counter**, not purely time-based — "out-of-sequence" requests are rejected even if the signature itself is valid. This is consistent with the recurring pattern we observed ourselves: the first navigation (executed directly by the browser) tends to succeed, while the subsequent replay outside the browser (axios, even using genuinely captured headers) is what starts failing.
- This signature is generated by heavily-obfuscated client-side logic (not a static formula that can be replicated with plain HMAC) — confirming that our approach (capturing the session from a real browser, rather than trying to statically reconstruct the signature algorithm) is the right direction, not a shortcut that should be avoided.
- Direct design implication: since replaying outside the browser is structurally prone to failing once the counter desyncs, `IN_BROWSER_FETCH` was changed from optional to **on by default** (see item #11 above) — every `get_pc`/`get_rw` call is executed by the same browser instance holding the session, instead of being replayed by a separate client.

## Known Limitations

- Signature/headers captured from one product navigation (`bootstrap`) may be specific to that product. If Shopee binds the signature to a particular `item_id`/`shop_id`, requests for another product outside the bootstrap session can trigger a classified error (`INVALID_RESPONSE`, see `src/lib/errors.ts`) — but this is handled automatically: `retry.ts` will trigger `session.manager.refresh()` **with the storeId/dealId currently being requested**, so the system effectively bootstraps a fresh browser session specifically for that product before retrying, then caches it for subsequent requests to the same product.
- A proxy is not provided by the task reviewer (per the task's constraints) — the user of this API is responsible for providing their own proxy via `PROXY_LIST` if needed.

### Note: Shopee traffic verification wall (`/verify/traffic/error`)

During development, it was found that Shopee TW has an anti-bot layer that redirects suspicious traffic to the page `shopee.tw/verify/traffic/error?...&is_logged_in=false` — it looks like a plain "please log in" page, but the URL path confirms this is a risk-control fallback, not a genuine login requirement.

Important finding from experimentation: this wall appears **consistently on the same device even when the IP/network is completely changed** (different SIM card, with/without VPN), but the very first request made before high-volume testing successfully returned full, real data — indicating this is a combined **rate/velocity-based risk score per device+network** that accumulates from repeated high-volume testing in a short time, not a structural failure in the scraper. `session.manager.ts` now explicitly detects a redirect to `/verify/traffic` and immediately raises a `TRAFFIC_VERIFICATION` error (fail fast + cooldown, **with no** automatic retry — see the External Analysis & Further Fixes section) instead of waiting out the full timeout.

Practical implication: for a real volume test (200+ items, long duration), **genuine proxy rotation is truly necessary** (not optional) so that no single IP accumulates enough requests to trigger this wall — matching the pluggable design of `proxy.manager.ts` built for exactly this need.

**Update — testing with a clean IP + a fully hardened browser:** to re-test the rate/velocity-based hypothesis above more rigorously, an additional experiment was run: manual browsing (not via the API) to `shopee.tw` using a combination of a **paid residential proxy (DataImpulse) with Taiwan geo-targeting** — not a free/public proxy — to ensure a genuinely fresh, verified-clean IP (geo-targeted via the `__cr.tw` suffix on the proxy credentials, not an IP already used in prior testing) **and** a browser built from this project's own anti-detection stack (`rebrowser-playwright` + stealth, see `scripts/browse.ts`) — not a plain Chrome with no mitigations at all.

Result: the verification/login wall still appeared, **not just for the 2 already-flagged sample items, but even for general navigation to `shopee.tw`** (before even clicking into any product). This is an important data point that narrows the hypothesis:

- Not purely about IP/network reputation — the Taiwan residential IP used was brand new and validated geo-correct.
- Not purely about browser fingerprint — the browser used had already gone through every CDP-leak mitigation and stealth measure documented above.
- The block occurs at the initial navigation level (homepage), not specifically on the 2 old items or on the `get_pc`/`get_rw` API calls.

Stronger conclusion: Shopee TW likely currently applies **combined risk-scoring across multiple layers at once** (device/browser signal, network, and possibly local account/browser session history) that can't be fully addressed from the client side alone — even so, the system's design (circuit breaker, `TRAFFIC_VERIFICATION` error classification, conservative retry policy, and the combinable technique options in `src/techniques/`) remains relevant as production mitigation, since this wall is fundamentally one failure mode that must be handled gracefully, not something that can be 100% avoided.

**Update — replication on another Shopee region (shopee.co.id), isolating the stealth-tooling variable.** To test whether this block is specific to the `.tw` domain or to our tooling's fingerprint, navigation to `shopee.co.id` (a different region, same platform) was tried from a network that **can** connect directly without DNS/SNI obstruction (see the DNS hijacking note below), with a genuinely fresh browser + session (no history whatsoever):

- The homepage personalization endpoints (`recommend/recommend`, `flash_sale/flash_sale_get_items`) returned the **identical `error: 90309999`** always encountered on `shopee.tw` — on the very first navigation, with no history, no proxy.
- Re-tested with `BROWSER_ENGINE=vanilla` (plain Playwright, **without** `rebrowser-playwright` or any stealth plugin at all) — the result was **identical**, `error: 90309999` still appeared.

Implication: this rules out the hypothesis that our stealth tooling (`rebrowser-playwright` + `puppeteer-extra-plugin-stealth`) is specifically recognized/fingerprinted — the error is identical even with all anti-detection tooling completely removed.

**Further confirmation: this wall gates the entire surface, not just personalization endpoints.** A follow-up attempt navigating to a category page (not the homepage) on the same fresh guest session resulted in a direct redirect to a full **"Login Required"** page (`Log In` / `Back to Homepage`) — a pattern identical to what was found on `shopee.tw` earlier (see the note above). This is the third time this exact pattern has been observed independently (homepage personalization on `.co.id`, category page on `.co.id`, and the wall on `.tw`), reinforcing the conclusion: from a genuinely fresh guest session (no history, no login, no old cookies), Shopee currently appears to gate **almost the entire browsing surface** — not just personal features — behind login, regardless of region or browser tooling used (including with no stealth at all).

This is no longer purely a "how do we avoid bot detection" question, but an indication that **guest/anonymous access to Shopee is currently very broadly restricted** — a product/policy decision that sits above anything client-side anti-detection techniques can address.

**Final confirmation — tested directly against `get_pc` on a real product:** using a valid, fresh `shopee.co.id` `shopId`/`itemId` (`50248646` / `18482027840`, this product was found by the tester via an account **that was logged in** — see the important note below), navigating directly to that product page from a genuinely fresh **guest** session (a fresh scraper browser, no proxy, direct connection, no login) still resulted in **`get_pc` returning `error: 90309999`** — the HTTP response itself is `200 OK`, but the JSON payload contains the same error code instead of product data. This pattern is identical to the personalization endpoints and the `.tw` login wall, now confirmed directly on this task's actual target endpoint (`get_pc`).

**Important note — this test product was found via a logged-in account.** The tester reported that just to *browse* and find the product above, their personal Shopee account had to be logged in — confirming from the human side (not just automation) that **guest browsing is indeed currently broadly restricted by Shopee**, not something specific to our scraper/automated browser. This is independent corroborating evidence on top of all the automation findings above, and reinforces the conclusion that the root cause is a guest-access policy, not bot detection that can be solved with client-side techniques.

Consistent with this task's scope (public scraping without a personal account/credentials, matching the original design assumption), the scraper **still runs in guest/anonymous mode** — it is not being pointed at a personal, already-logged-in account session, both because that's outside the task's original scope and because of the risk of a real account getting flagged/banned from 200+ automated requests. This guest-access restriction is documented here as an **external limitation on Shopee's side at the time of testing**, not a scraper design failure — the architecture (session capture from a real browser, retry/circuit-breaker per error classification, etc.) remains the correct approach for a guest-scraping scenario once Shopee's access policy loosens again, or when run from network/account conditions that haven't been throttled.

**Note on why `.co.id` was used instead of `.tw` for login testing.** Shopee accounts are region-specific, not shared across countries — using Shopee in a different country requires that country's app and a **locally-registered phone number** (a `shopee.co.id` account cannot log into `shopee.tw`, they are entirely separate account systems, not just a language/display difference on the same platform). Since the tester only had an Indonesian phone number/account available, all `AUTH_MODE=login` testing below was necessarily run against `shopee.co.id` rather than the task's actual `shopee.tw` target. This doesn't undermine the findings architecturally — the same platform and the identical `90309999` pattern have already been shown to replicate across regions (see the `.co.id` replication note above) — but it does mean the specific `AUTH_MODE=login` results below are not yet independently validated with a genuine `shopee.tw` account.

**Update — testing with a genuine login session (`AUTH_MODE=login` feature), correcting the conclusion above.** To isolate the login-vs-guest variable directly (not just speculation), an `AUTH_MODE=login` mode was built (see [Guest vs Login Mode](#guest-vs-login-mode-auth_mode)) that loads a *storage state* from a genuinely completed manual login (a real account, via `npm run login`, with OTP/captcha filled in directly by a human). It was tested against the same `shopee.co.id` product (`shopId=50248646`, `itemId=18482027840`) that the tester had previously found via their own logged-in account.

Result: **`get_pc` still returned `error: 90309999`, identical to guest mode** — even though the browser bootstrap carried genuinely valid login session cookies. This corrects the earlier conclusion: **login/guest status turns out not to be the differentiating factor.** Since the tester themselves (a human, a regular browser, not automation) successfully browsed and found the same product with the same account, while the identical login session failed when accessed via our automated browser (Playwright/CDP, even with `rebrowser-playwright` + stealth) — the differentiator is most likely back to **automation/CDP detection itself**, not a guest-access policy as previously suspected. This is consistent with this project's earliest result (the only full success happened on the very first request before high-volume testing) and reinforces that the root cause sits at a level of automated-browser detection deeper than any combination of publicly available anti-detection techniques (`rebrowser-playwright`, stealth plugin, etc.) documented in this project can address.

**Further isolation — the real Chrome binary via `channel: "chrome"` (not Chrome-for-Testing).** To rule out the hypothesis that Chrome-for-Testing (the binary `rebrowser-playwright` bundles by default) has its own recognizable identity signal, `BROWSER_CHANNEL=chrome` support was added (see `src/services/session.manager.ts`), making Playwright launch the **actual installed, genuine Chrome stable**, combined with `BROWSER_ENGINE=vanilla-stealth` (avoiding `rebrowser-playwright`'s CDP-patch incompatibility with the stable Chrome protocol revision — see method #8 in the experiment table) and the same login session.

Result, for the third time independently: **`get_pc` still returns `error: 90309999`.** At this point, three major variables have been eliminated one by one — network/IP (a clean Taiwan residential IP still fails), stealth tooling (vanilla with zero stealth still fails), login status (a genuine login session still fails), and now the browser binary (a real Chrome stable, not Chrome-for-Testing, still fails). The only remaining difference between this automated testing and the tester's successful manual browsing is **CDP/Playwright control itself** — Chrome driven via the automation protocol (Chrome DevTools Protocol), however similar the binary and session are to the Chrome used manually, versus Chrome actually clicked directly by a human with no automation intermediary at all.

**The most extreme isolation attempt — CDP-attach to the tester's default Chrome profile — blocked by Chrome itself.** A final attempt at total isolation (Playwright *connecting* to the tester's default Chrome instance that was already opened & manually logged in, rather than launching anything new at all) couldn't be run: modern Chrome **refuses to enable the remote debugging port on the default profile** (`--remote-debugging-port` is set but the port never actually listens), as an official Chrome security hardening measure to prevent foreign automation from CDP-attaching to a user's already fully-logged-in browser — exactly the scenario being tested here. The workaround (a separate Chrome profile + logging in manually again in that profile) is substantively equivalent to the `AUTH_MODE=login` test already done above, so it wouldn't provide new data. This is itself an interesting minor finding: Chrome actively makes the "CDP controlling a user's real browser profile" scenario difficult — aligning with the conclusion that CDP/automation control is a signal that's structurally hard to fully disguise, beyond the reach of any application-level anti-detection technique.

**Two additional isolations: headless vs. headful, and `patchright` (the most thorough publicly available CDP patch).**

- **Headless vs. headful (`HEADLESS=false`).** All prior `get_pc` tests via the server (`session.manager.ts`) ran headless by default — while `scripts/login.ts`/`scripts/browse.ts`, which succeeded at manual browsing, always ran headful. This is a variable that had never been controlled for. Tested with `HEADLESS=false` (a genuinely visible browser, not just Chrome's "new headless mode") using the same login session: the result was identical, still `error: 90309999` / the `/verify/traffic` wall.
- **`patchright` — the most thorough publicly available CDP patch as of 2026 research.** `rebrowser-playwright` patches a specific `Runtime.enable` leak, but external research (see the citations below) shows there's a broader class of other CDP leaks: `Runtime.enable` serialization observable via getters, the `Console.enable` leak, and command-line flags like `--enable-automation`. [`patchright`](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) (installed via `npm i patchright && npx patchright install chromium`, selected via `BROWSER_ENGINE=patchright`) closes that entire class of leaks — avoiding `Runtime.enable` entirely via isolated execution contexts, patching the `Console.enable` leak, and stripping `--enable-automation` from the launch arguments. Tested with the same login session: **the result was still `error: 90309999`**, although this time without the usual CDP crash noise seen with `rebrowser-playwright` (patchright handles the CDP protocol more cleanly technically, but the anti-bot detection outcome is identical).

**Summary of seven independent variables eliminated**, all producing the identical `error: 90309999`:

| # | Variable | How it was isolated | Result |
|---|---|---|---|
| 1 | Network/IP | A **paid** residential proxy with Taiwan geo-targeting (DataImpulse, clean & fresh) | Still failed |
| 2 | Stealth tooling | `BROWSER_ENGINE=vanilla` (no mitigation at all) | Still failed |
| 3 | Login status | `AUTH_MODE=login` with a genuine account session | Still failed |
| 4 | Browser binary | `BROWSER_CHANNEL=chrome` (real Chrome stable) | Still failed |
| 5 | Headless vs. headful | `HEADLESS=false` | Still failed |
| 6 | Depth of CDP patching | `BROWSER_ENGINE=patchright` (the most thorough publicly available patch) | Still failed |
| 7 | Device emulation (mobile vs. desktop) | `DEVICE_EMULATION=mobile` (viewport, touch, iOS Safari UA) | Still failed |

**Independent external validation (not just this project's own finding).** Public research from mid-2026 confirms the exact same pattern on another Shopee region:

> "There is no working unauthenticated path on Shopee Malaysia as of 2026-05-20. The v4 JSON API returns error: 90309999 ... Shopee's WAF accepts the cookies and knows the user is logged in; it's blocking on the missing [per-request] signature... the block is fingerprint-based, making it difficult to bypass through traditional proxy methods alone."

This quote independently confirms: (a) the exact same error code (`90309999`) appears on a different Shopee region, not just `.tw`/`.co.id`; (b) there is no working unauthenticated path across the entire Shopee platform currently, according to the external scraping community; (c) even a cookie-bearing/logged-in session is still blocked based on the execution-context fingerprint, not cookie validity itself — exactly matching the `AUTH_MODE=login` finding above.

**Final conclusion.** With seven independent variables systematically eliminated and validated by external sources unrelated to this project, the evidence points strongly to one thing: Shopee currently runs an anti-bot system that evaluates **the JavaScript execution context itself** (likely via server-observable CDP-protocol-level signals — microtask timing, injected-code execution traces, or other CDP signals beyond the scope of `Runtime.enable`/`Console.enable`/command-flags already patched by `patchright`) — not IP, not login, not the browser binary, not headless mode. This is consistent with the "fingerprint-based blocking" definition cited by external research, and is beyond the reach of any combination of publicly available anti-detection techniques as of this documentation's writing.

<sub>Sources: [browse.sh — Shopee Malaysia Product Search](https://browse.sh/skills/shopee.com.my/search-products-5epzg0), [Foil — CDP detection in 2026](https://usefoil.com/learn/cdp-detection), [crawlex.net — Detecting CDP in the wild](https://blog.crawlex.net/blog/detecting-cdp-runtime-enable/), [DataDome — New Headless Chrome & the CDP Signal](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/), [patchright-nodejs](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs).</sub>

### Further analysis: ruling out the signature-replay hypothesis

The investigation report above (sections 6–8) was also given to two external AI assistants for a second opinion. Both analyses agreed in ranking the "purely about signature/proxy/stealth" hypothesis as low confidence — consistent with the 6-variable elimination table above — but one proposed a decisive experiment we hadn't explicitly run as a separate test: **compare the `get_pc` request genuinely made by Shopee's own JS (native) vs. our `page.evaluate(fetch())` vs. axios, for the same product & session** — if all three fail identically, then it's not about replay/transport, but the environment/browser itself already being rejected before the request is even sent.

It turns out **we already had the answer from existing data**: `bootstrap()` in `session.manager.ts` intercepts the `get_pc` request made purely by Shopee's own JS (`page.on("request")` + `waitForResponse`, before our code does any `page.evaluate` or axios call at all) — and this native response **already** contains `error: 90309999` from the start. That means: native = in-browser-fetch = axios, all three fail identically. This rules out the signature-replay/transport-mismatch hypothesis as the root cause — consistent with the 6-variable elimination table, and reaffirming that the problem is at the environment/browser level being rejected before any request is even sent, not the quality of the header replay.

Additional note: one of the external analyses speculated the block happens purely at the Edge/WAF level (TCP/TLS handshake) before JS even runs at all. This is less consistent with the evidence we have — the captured response has a full JSON structure matching Shopee's normal schema (`"0","1","2","3":90309999,...,"6":<blob>`), characteristic of a response from Shopee's own application layer, not a generic edge/WAF block page (which is usually HTML or a connection reset, not a neatly structured JSON).

**Angles genuinely not yet tested** from these two analyses, for further experiments given time/access to new products:
- **A full, realistic navigation chain** (homepage → search → category → click into the product, instead of `page.goto()` directly to the product URL) within one persistent session, tested across several products in sequence — different from our current "warmup" technique, which only stops by the homepage + a random delay before still `goto()`-ing directly to the product URL.

**Additional finding — two other public Shopee scraper projects (GitHub, reference: `dtungpka/shopee-scraper`, `toptankcpe/shopee-scraper`) turn out to operate at a completely different layer.** Both use Selenium/SeleniumBase with manual login + a human-solved captcha, but **never touch `get_pc`/`get_rw` as a separate API** — they scrape the already-rendered page's DOM (name, price, review) via visual elements, not by intercepting the JSON response. Neither one mentions the `90309999` error code or a specific anti-crawler bypass strategy in their README.

To test whether this approach could be a way out, a full render of the product page was tried (`shopee.co.id`, same login session, same product), checking: (a) the initial HTML (SSR, before JS runs) for embedded state, and (b) the DOM after a full render. The result had an important nuance: **the initial HTML does contain an `initialState` blob with `shopId`/`itemId`, and the page successfully rendered the product name, images, rating, sold count, full description, and stock status — all displaying normally, visually.** But **the product price and shipping info were empty** (a gray placeholder that never got filled in) — exactly at the point of data that depends on the failed `get_pc`. `price_min`/`price_max` in the `initialState` blob were also `null`.

Conclusion from this finding: the problem is **precise** to data that depends on `get_pc`, not a broad session/page failure — content coming from other sources (likely a separate endpoint/CDN for product metadata, images, description) still loads normally. This also means the DOM-scraping approach (like the two reference projects above) **would not satisfy this task's target schema** (`get_pc.response_example.txt`, which is dominated by price/`shop_detailed`/`product_shipping`/`product_review` fields) — while it could be used for non-commercial fields like title/description/images, the most critical fields (price, shipping cost) remain unavailable through this path.

**Important operational note — risk-scoring escalation on the test account.** The latest attempt (navigating via genuine clicks: homepage → search → click a product, instead of `goto()` directly, to test the "realistic navigation chain" angle from external analysis) didn't get to test its hypothesis — navigating to the homepage was **immediately** redirected to `/verify/captcha` (a genuine CAPTCHA challenge), no longer just a silent `error: 90309999` or the usual `/verify/traffic` wall. This is a new escalation tier, most likely due to the volume of repeated automated testing against the same account/session throughout this investigation session. Further live testing against this account was **stopped** at this point to avoid further risk to the tester's personal account — consistent with the `TRAFFIC_VERIFICATION` design principle in `retry.ts` (0 automatic retries), which was built from the start on the concern that repeated activity after a block tends to worsen, not improve, the risk score.

**An angle already tested (7th confirmation):** mobile device emulation (`DEVICE_EMULATION=mobile` — viewport 390×844, `isMobile: true`, `hasTouch: true`, iOS Safari User-Agent, see `src/services/session.manager.ts`), based on the theory that Shopee has a higher trust bias toward mobile-web traffic. Tested with the same login session: **still `error: 90309999`**. An interesting note from this test: even in mobile emulation mode, Shopee's own page still called `get_pc` (not `get_rw`) — suggesting `get_rw` is likely specific to native-app traffic (`x-api-source: rn`), not a mobile *web* browser, so the "pivot to `get_rw` + mobile UA" idea from one of the external analyses doesn't really apply to a mobile-web scenario like this.

### Analysis of two other reference projects: "device-cookie binding" as the most coherent explanation

Two other public projects (one Shopee MCP server, one Rust crate for interacting with the Shopee API) were studied in depth (without further live testing, given the risk-scoring escalation note above). Both are independent of each other, and both **converge on the same conclusion** — which also most coherently explains why our `AUTH_MODE=login` failed even with 100%-valid cookies.

**The MCP server project**: uses a Chromium browser patched at the **binary level** (not a JS/CDP-command patch like `rebrowser-playwright`/`patchright` that we already tried — a deeper, commercial/closed-source class of mitigation), run headed, and — the most relevant point — uses a **persistent Chrome profile logged in once and then reused over time**, not `storageState` (a cookies+localStorage snapshot). Its documentation explicitly states plain fetch, headless Chromium, and hand-rolled requests all get `error 90309999` — exactly matching our own findings.

**The Rust crate project**: independently confirms TLS fingerprint isn't the main cause (tested with Chrome 145 TLS emulation via `wreq`, still `90309999`), with this key quote:

> "The signal Shopee scores on isn't headless-detection or behavioral telemetry — it's deeper (**browser-fingerprint cleanliness, device-cookie binding**)."

Its solution: CDP-attach directly to the user's **own already-logged-in real Chrome** (`127.0.0.1:9222`) — not a new browser with injected cookies.

**Why this matters.** "Device-cookie binding" explains exactly why our `AUTH_MODE=login` failed: cookies are likely bound to the specific *device fingerprint* that issued them, not just whether the cookie itself is valid. Our `storageState` copies cookies+localStorage into a **new, clean** Playwright context — to Shopee, that isn't the same device, even with byte-for-byte identical cookies.

This also maps out three different approaches, not all of which we've properly tried:

| Approach | Already tried? | Result |
|---|---|---|
| New browser + `storageState` (injected cookies) | ✅ (`AUTH_MODE=login`) | Failed — device fingerprint doesn't match |
| CDP-attach to the user's **default** Chrome | ✅ (tried, blocked) | Blocked by **Chrome itself** (default-profile security hardening), never got as far as Shopee |
| A **dedicated, separate** Chrome profile, logged in once, reused persistently over time (not a snapshot) | ❌ Never tried | — |

The third row is a genuine gap between the two prior attempts — `PERSISTENT_PROFILE=true` already exists in `session.manager.ts`, but has never actually been tested with a genuine login inside it and reused over time (rather than used once). This is the most promising direction for further experiments, on the condition of using a new, not-yet-flagged account/profile (not the account that already hit the CAPTCHA escalation above), and run very conservatively (real time gaps between uses, not straight into volume testing) to avoid repeating the same escalation.

<sub>Sources: [shopee-mcp](https://github.com/bintangtimurlangit/shopee-mcp), [tail-fin-shopee](https://docs.rs/tail-fin-shopee/latest/tail_fin_shopee/).</sub>

### Note: DNS hijacking on certain networks (e.g. Indonesian ISPs)

During development, it was found that some ISP networks (e.g. Telkomsel/"internetbaik") perform **DNS hijacking** for the `shopee.tw` domain — DNS resolution is redirected to an ISP-owned block-page IP instead of Shopee's real IP, so both direct access and access via some proxies (that resolve the hostname locally, e.g. classic SOCKS4) fail completely even though the code and the proxy itself work normally.

How to detect this issue:

```bash
# Compare local DNS resolution vs. a third-party DNS-over-HTTPS resolver
nslookup shopee.tw
curl -s "https://cloudflare-dns.com/dns-query?name=shopee.tw&type=A" -H "accept: application/dns-json"
```

If the two IPs are very different (one belongs to a local ISP, the other to Shopee/Cloudflare/Akamai infrastructure), your network is DNS-hijacking this domain.

**Update — the block also happens at the SNI level, not just DNS.** Even when Shopee's real IP is explicitly forced (`curl --resolve shopee.tw:443:<real-IP>`, bypassing the DNS hijack), the TLS connection still fails with `Connection reset by peer` right after the `ClientHello` (at the point where the `shopee.tw` SNI is sent in plaintext) — a classic pattern of network-level DPI (deep packet inspection) SNI-based blocking, outside the application/code's control. In practice: on a network with this combined DNS-hijack + SNI-block, **a direct (no-proxy) connection to `shopee.tw` is impossible to succeed at all** — not a Shopee anti-bot detection issue, but the local network itself cutting the connection before it ever reaches Shopee. This explains why a proxy (which makes an outbound TLS connection with the SNI set to the proxy's own domain, not `shopee.tw`, from outside the blocked network) remains a necessary mitigation on networks like this — not just to avoid Shopee's IP-reputation checks, but also to get past the local network block itself.

Workaround if you hit something similar: switch your system's DNS resolver to a third-party one that isn't hijacked (e.g. `1.1.1.1`/`8.8.8.8` via DoH/DoT), or use a proxy/VPN that resolves DNS **on the remote side** (SOCKS5 with `--socks5-hostname`, not classic SOCKS4) so resolution doesn't depend on the already-hijacked local DNS.
