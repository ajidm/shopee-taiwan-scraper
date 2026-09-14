export type ScrapeErrorType =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "HTTP_403"
  | "HTTP_429"
  | "TRAFFIC_VERIFICATION"
  | "INVALID_RESPONSE"
  | "SESSION_EXPIRED"
  | "PROXY_FAILURE"
  | "BROWSER_FAILURE";

/**
 * Every failure in the scrape pipeline is normalized into one of these categories so
 * retry.ts can apply a distinct policy per type instead of treating all failures the
 * same way. Some categories (TRAFFIC_VERIFICATION in particular) are intentionally
 * NOT retried aggressively — hammering Shopee's risk-control wall with more browser
 * bootstraps is suspected to worsen the underlying risk/velocity score rather than
 * resolve it.
 */
export class ScrapeError extends Error {
  readonly type: ScrapeErrorType;

  constructor(type: ScrapeErrorType, message: string) {
    super(message);
    this.name = "ScrapeError";
    this.type = type;
  }
}

export function isScrapeError(err: unknown): err is ScrapeError {
  return err instanceof ScrapeError;
}
