import axios, { AxiosError } from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { logger } from "../lib/logger";
import { rateLimiter } from "../lib/rateLimiter";
import { AntiBotError, withRetry } from "../lib/retry";
import { proxyManager } from "./proxy.manager";
import { sessionManager } from "./session.manager";
import type { ShopeeApiEndpoint, ShopeeProductParams } from "../types/shopee";

const REQUEST_TIMEOUT_MS = 15_000;

function buildUrl(endpoint: ShopeeApiEndpoint, params: ShopeeProductParams): string {
  const qs = new URLSearchParams({
    item_id: params.dealId,
    shop_id: params.storeId,
  });
  return `https://shopee.tw/api/v4/pdp/${endpoint}?${qs.toString()}`;
}

async function callEndpoint(endpoint: ShopeeApiEndpoint, params: ShopeeProductParams): Promise<unknown> {
  const session = await sessionManager.getValidSession(params);

  // For get_pc, prefer the response captured directly from the browser during bootstrap —
  // it's guaranteed authentic, whereas replaying headers via axios can get soft-blocked.
  if (endpoint === "get_pc" && session.capturedResponse && isUsableProduct(session.capturedResponse)) {
    return session.capturedResponse;
  }

  const proxyUrl = proxyManager.getProxy();

  const headers: Record<string, string> = {
    ...session.headers,
    cookie: session.cookieHeader,
    referer: `https://shopee.tw/a-i.${params.storeId}.${params.dealId}`,
  };
  // Content-length from the captured request no longer applies to this GET call.
  delete headers["content-length"];

  try {
    const response = await axios.get(buildUrl(endpoint, params), {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      httpsAgent: proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined,
      validateStatus: () => true,
    });

    if (response.status === 403 || response.status === 429) {
      if (proxyUrl) proxyManager.reportFailure(proxyUrl);
      throw new AntiBotError(`Blocked by Shopee anti-bot on ${endpoint} (status ${response.status})`);
    }

    if (response.status >= 500) {
      throw new Error(`Shopee ${endpoint} returned server error ${response.status}`);
    }

    if (proxyUrl) proxyManager.reportSuccess(proxyUrl);
    logger.info(
      { endpoint, status: response.status, bodyPreview: JSON.stringify(response.data).slice(0, 500) },
      "Shopee endpoint response received"
    );
    return response.data;
  } catch (err) {
    if (err instanceof AntiBotError) throw err;
    if (proxyUrl) proxyManager.reportFailure(proxyUrl);
    if (err instanceof AxiosError) {
      throw new Error(`Network error calling ${endpoint}: ${err.message}`);
    }
    throw err;
  }
}

function isUsableProduct(data: unknown): boolean {
  const d = data as { data?: { item?: unknown }; error?: unknown } | null;
  return Boolean(d && d.data && d.data.item && !d.error);
}

export async function getProductDetail(params: ShopeeProductParams): Promise<unknown> {
  return rateLimiter.schedule(() =>
    withRetry(
      async () => {
        const primary = await callEndpoint("get_pc", params);
        if (isUsableProduct(primary)) return primary;

        logger.warn({ params }, "get_pc returned no usable item, falling back to get_rw");
        const fallback = await callEndpoint("get_rw", params);
        if (isUsableProduct(fallback)) return fallback;

        // Shopee returning a 200 with no item is treated as a soft anti-bot signal (rather
        // than a hard error), since a stale/mismatched session is the most likely cause —
        // this makes withRetry refresh the session before retrying instead of hammering it.
        throw new AntiBotError("Both get_pc and get_rw returned no usable item data");
      },
      {
        onAntiBotDetected: async () => {
          await sessionManager.refresh(params);
        },
      }
    )
  );
}
