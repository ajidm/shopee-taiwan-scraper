# Personal Notes — Two Scraping Methods

This is a personal reference doc, separate from the submission README (`../README.md` /
`../README.id.md`). It's not part of the graded deliverable — just combined notes on both
methods that exist in this repo, kept here for my own future reference.

## Method 1 — API interception (`get_pc`/`get_rw`)

This is the actual submission scope. Full docs live in `../README.md` (English) /
`../README.id.md` (Indonesian) — architecture, all 12+ anti-detection techniques, the whole
investigation into Shopee's anti-bot system, and the honest conclusion about what did and
didn't work.

**Endpoint:** `GET /shopee?storeId={storeId}&dealId={dealId}`

**How it works:** Playwright navigates to the real product page, intercepts the exact
`get_pc`/`get_rw` network request Shopee's own front-end makes, and returns that response
verbatim (passthrough, no transformation). This matches the task's required output format
exactly, since it's Shopee's own real API response.

**Status:** works mechanically end-to-end (proven early on, and twice more via the
click-navigation breakthrough — see the main README's "Known Limitations" section) but gets
blocked by Shopee's anti-bot (`error: 90309999`) most of the time in practice, for reasons
extensively investigated but not fully solved (see the main README for the full writeup —
nine independent variables eliminated, external research reviewed, etc).

## Method 2 — DOM scraping (this folder)

A separate experiment, closer to what public Shopee scrapers like `dtungpka/shopee-scraper`
and `toptankcpe/shopee-scraper` do (both referenced in the main README): instead of
intercepting the internal API, treat the product page like a normal visitor would and pull
data out of the fully-rendered page itself.

**Endpoint:** `GET /shopee/dom?storeId={storeId}&dealId={dealId}`

**How it works** (see `domScraper.ts`):
1. Navigate to `https://{SHOPEE_DOMAIN}/product-i.{shopId}.{itemId}`.
2. Grab the raw HTML response and extract the `initialState` JSON blob Shopee's React app
   embeds directly in the page (server-rendered, present before any client-side JS runs) —
   found during the SSR investigation documented in the main README. A hand-rolled
   balanced-brace parser (`extractBalancedJson`) pulls out the object since it can't be
   isolated with a simple string search (nested braces).
3. Recursively search that object for known field names (`findFirstByKeys`) — this is
   deliberately generic rather than hardcoding exact nested paths, since I don't have a
   full, un-truncated sample of the object's real shape to hardcode against confidently.
4. Separately, do a best-effort text-based scrape of visible reviews from the rendered DOM
   (`extractVisibleReviews`) — reviews are usually lazy-loaded and not reliably present in
   `initialState`, so this parses `document.body.innerText` looking for a lone star-rating
   digit (1–5) followed by a review-length line of text. Fragile, but reviews aren't the
   main point of this endpoint.

**Response shape:**

```ts
{
  itemId: string;
  shopId: string;
  url: string;
  title: string | null;
  price, priceMin, priceMax, currency: unknown;
  images: unknown;              // array of image IDs, same format as get_pc
  ratingStar, totalRatingCount, soldCount: unknown;
  description: unknown;
  stock: unknown;
  brand: unknown;
  shopName, shopLocation: unknown;
  categories: unknown;
  reviews: { ratingStar: number | null; text: string }[];
  raw: unknown;                 // the full parsed initialState object, for anything not mapped above
}
```

Most fields are typed `unknown` on purpose — `findFirstByKeys` doesn't know the real schema,
so the caller (me, later) is expected to inspect `raw` if a field comes back `null` and
either fix the key list in `domScraper.ts` or pull it manually from `raw`.

**Tested and confirmed working** once, live, against a `shopee.co.id` watch listing
(`shopId=3720074`, `itemId=1435616038`) — title, description, images, stock, shop info, and
categories all came back correctly. A second call moments later against the same item came
back empty (no error thrown, just nothing extracted) — consistent with the same
intermittency documented extensively for Method 1 in the main README (this project's shared
conclusion: Shopee's blocking is inconsistent request-to-request, not a hard permanent wall
in every case).

**Known limitations:**
- `price`/`priceMin`/`priceMax`/`ratingStar` may come back `null` even on a successful
  fetch if the real key name inside `initialState` doesn't match what `findFirstByKeys`
  is looking for — check `raw` in the response to find the actual key and fix the list.
- Reviews extraction only covers whatever's rendered on first load — no scroll/pagination
  to load more.
- Same anti-bot exposure as Method 1 (this hits the real product page too) — everything in
  the main README about proxies, `SHOPEE_DOMAIN`, `AUTH_MODE`, `PERSISTENT_PROFILE`, and
  `BROWSER_ENGINE` applies here too (this module reuses `getConfiguredBrowserEngine()`),
  except this endpoint doesn't currently wire through `AUTH_MODE`/`PERSISTENT_PROFILE` —
  it always launches a fresh ephemeral guest context. Add that wiring if needed later.
- No retry/circuit-breaker logic (unlike `src/services/shopee.client.ts`) — a failed
  navigation just returns nulls, it doesn't throw or retry.

## Comparing the two

| | Method 1 (`/shopee`) | Method 2 (`/shopee/dom`) |
|---|---|---|
| Data source | Real `get_pc`/`get_rw` API response | Rendered page's `initialState` blob + DOM text |
| Matches task's required schema | Yes, exactly (it's Shopee's own response) | No — custom shape, approximates the same fields |
| Price/shipping reliability | Whatever Shopee's API returns | Sometimes `null` if the key name isn't in the lookup list yet |
| Reviews | Included in `get_pc`'s own review summary fields | Best-effort scraped from visible text, first page only |
| Retry/circuit-breaker/proxy rotation | Yes, full `src/lib/retry.ts` + `proxy.manager.ts` | No — bare navigation, no retry |
| Anti-bot exposure | Same underlying block, extensively documented | Same underlying block, same product pages |

## Running

Both endpoints run on the same server (`npm run dev`), since `personal/dom.route.ts` is
wired into `src/server.ts` alongside the main `/shopee` route:

```bash
curl "http://localhost:3000/shopee?storeId=178926468&dealId=21448123549"        # Method 1
curl "http://localhost:3000/shopee/dom?storeId=178926468&dealId=21448123549"    # Method 2
```

Set `SHOPEE_DOMAIN=shopee.co.id` (or whichever region) the same way as documented in the
main README, since both methods share that env var.
