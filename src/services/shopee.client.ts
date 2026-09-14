import axios, { AxiosError } from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { logger } from "../lib/logger";
import { rateLimiter } from "../lib/rateLimiter";
import { ScrapeError } from "../lib/errors";
import { withRetry } from "../lib/retry";
import { withEndpointFallback } from "../techniques";
import { proxyManager } from "./proxy.manager";
import { sessionManager } from "./session.manager";
import type { ShopeeApiEndpoint, ShopeeProductParams, ShopeeSession } from "../types/shopee";

const REQUEST_TIMEOUT_MS = 15_000;

// Experimental (IN_BROWSER_FETCH=true): route repeat get_pc/get_rw calls through a real
// Chromium page.evaluate(fetch(...)) instead of axios, eliminating any TLS/HTTP2 fingerprint
// mismatch between the browser that established the session and the client replaying it.
const IN_BROWSER_FETCH = process.env.IN_BROWSER_FETCH === "true";

function buildUrl(endpoint: ShopeeApiEndpoint, params: ShopeeProductParams): string {
  const qs = new URLSearchParams({
    item_id: params.dealId,
    shop_id: params.storeId,
  });
  return `https://shopee.tw/api/v4/pdp/${endpoint}?${qs.toString()}`;
}

function buildHeaders(session: ShopeeSession, params: ShopeeProductParams): Record<string, string> {
  const headers: Record<string, string> = {
    ...session.headers,
    cookie: session.cookieHeader,
    referer: `https://shopee.tw/a-i.${params.storeId}.${params.dealId}`,
  };
  // Content-length from the captured request no longer applies to this GET call.
  delete headers["content-length"];
  return headers;
}

async function callViaAxios(
  endpoint: ShopeeApiEndpoint,
  params: ShopeeProductParams,
  session: ShopeeSession,
  requestId: string | undefined
): Promise<unknown> {
  // Reuse the exact proxy the browser used to build this session — not a fresh pick —
  // so the exit IP stays consistent for the session's whole lifetime (see proxy.manager.ts).
  const proxyUrl = session.proxyUrl;
  const headers = buildHeaders(session, params);
  const startedAt = Date.now();

  try {
    const response = await axios.get(buildUrl(endpoint, params), {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      httpsAgent: proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined,
      validateStatus: () => true,
    });

    if (response.status === 403) {
      if (proxyUrl) proxyManager.reportFailure(proxyUrl);
      throw new ScrapeError("HTTP_403", `Blocked by Shopee anti-bot on ${endpoint} (403)`);
    }
    if (response.status === 429) {
      if (proxyUrl) proxyManager.reportFailure(proxyUrl);
      throw new ScrapeError("HTTP_429", `Rate limited by Shopee on ${endpoint} (429)`);
    }
    if (response.status >= 500) {
      throw new ScrapeError("NETWORK_ERROR", `Shopee ${endpoint} returned server error ${response.status}`);
    }

    if (proxyUrl) proxyManager.reportSuccess(proxyUrl);
    logger.info(
      {
        requestId,
        endpoint,
        statusCode: response.status,
        responseHasItem: isUsableProduct(response.data),
        latencyMs: Date.now() - startedAt,
        sessionAgeMs: Date.now() - session.capturedAt,
        proxyId: proxyUrl ? new URL(proxyUrl).host : null,
        browserMode: "axios",
        bodyPreview: JSON.stringify(response.data).slice(0, 500),
      },
      "Shopee endpoint response received (axios)"
    );
    return response.data;
  } catch (err) {
    if (err instanceof ScrapeError) throw err;
    if (proxyUrl) proxyManager.reportFailure(proxyUrl);
    if (err instanceof AxiosError) {
      const type = err.code === "ECONNABORTED" ? "TIMEOUT" : "NETWORK_ERROR";
      throw new ScrapeError(type, `${type === "TIMEOUT" ? "Timeout" : "Network error"} calling ${endpoint}: ${err.message}`);
    }
    throw new ScrapeError("NETWORK_ERROR", err instanceof Error ? err.message : String(err));
  }
}

async function callViaBrowser(
  endpoint: ShopeeApiEndpoint,
  params: ShopeeProductParams,
  session: ShopeeSession,
  requestId: string | undefined
): Promise<unknown> {
  const startedAt = Date.now();
  try {
    const { status, body } = await sessionManager.fetchInBrowser(buildUrl(endpoint, params), session);

    if (status === 403) throw new ScrapeError("HTTP_403", `Blocked by Shopee anti-bot on ${endpoint} (403)`);
    if (status === 429) throw new ScrapeError("HTTP_429", `Rate limited by Shopee on ${endpoint} (429)`);
    if (status >= 500) throw new ScrapeError("NETWORK_ERROR", `Shopee ${endpoint} returned server error ${status}`);

    const data = JSON.parse(body);
    logger.info(
      {
        requestId,
        endpoint,
        statusCode: status,
        responseHasItem: isUsableProduct(data),
        latencyMs: Date.now() - startedAt,
        sessionAgeMs: Date.now() - session.capturedAt,
        proxyId: session.proxyUrl ? new URL(session.proxyUrl).host : null,
        browserMode: "in-browser-fetch",
        bodyPreview: body.slice(0, 500),
      },
      "Shopee endpoint response received (in-browser fetch)"
    );
    return data;
  } catch (err) {
    if (err instanceof ScrapeError) throw err;
    throw new ScrapeError("BROWSER_FAILURE", `In-browser fetch failed for ${endpoint}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function callEndpoint(
  endpoint: ShopeeApiEndpoint,
  params: ShopeeProductParams,
  requestId: string | undefined
): Promise<unknown> {
  const session = await sessionManager.getValidSession(params);

  // For get_pc, prefer the response captured directly from the browser during bootstrap —
  // it's guaranteed authentic, whereas replaying headers via a different client can get
  // soft-blocked if the client's TLS/HTTP2 fingerprint doesn't match the browser's.
  if (endpoint === "get_pc" && session.capturedResponse && isUsableProduct(session.capturedResponse)) {
    return session.capturedResponse;
  }

  const data = IN_BROWSER_FETCH
    ? await callViaBrowser(endpoint, params, session, requestId)
    : await callViaAxios(endpoint, params, session, requestId);

  if (isUsableProduct(data)) {
    sessionManager.recordSuccess(params);
  } else {
    sessionManager.recordError(params);
  }
  return data;
}

function isUsableProduct(data: unknown): boolean {
  const d = data as { data?: { item?: unknown }; error?: unknown } | null;
  return Boolean(d && d.data && d.data.item && !d.error);
}

export async function getProductDetail(params: ShopeeProductParams, requestId?: string): Promise<unknown> {
  return rateLimiter.schedule(() =>
    withRetry(
      // Technique #8: automatic get_pc → get_rw fallback.
      () =>
        withEndpointFallback(
          (endpoint) => callEndpoint(endpoint, params, requestId),
          isUsableProduct,
          { requestId, params }
        ),
      {
        onSessionRefresh: async () => {
          await sessionManager.refresh(params);
        },
        onProxyFailure: (err) => {
          logger.warn({ params, message: err.message }, "Proxy failure during scrape");
        },
      }
    )
  );
}
