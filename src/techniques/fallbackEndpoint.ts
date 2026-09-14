import { logger } from "../lib/logger";
import { ScrapeError } from "../lib/errors";
import type { ShopeeApiEndpoint } from "../types/shopee";

/**
 * Technique #8 (Teknik Anti-Deteksi): if get_pc doesn't return a usable item, automatically
 * fall back to get_rw as a secondary source before giving up.
 */
export async function withEndpointFallback<T>(
  callEndpoint: (endpoint: ShopeeApiEndpoint) => Promise<T>,
  isUsable: (data: T) => boolean,
  context: Record<string, unknown> = {}
): Promise<T> {
  const primary = await callEndpoint("get_pc");
  if (isUsable(primary)) return primary;

  logger.warn(context, "get_pc returned no usable item, falling back to get_rw");
  const fallback = await callEndpoint("get_rw");
  if (isUsable(fallback)) return fallback;

  throw new ScrapeError("INVALID_RESPONSE", "Both get_pc and get_rw returned no usable item data");
}
