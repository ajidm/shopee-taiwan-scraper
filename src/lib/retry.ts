import { logger } from "./logger";
import { isScrapeError, ScrapeError, type ScrapeErrorType } from "./errors";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  const jitter = Math.random() * 250;
  return base + jitter;
}

interface RetryPolicy {
  maxRetries: number;
  /** Whether this error type warrants a full session (browser) refresh before retrying. */
  needsSessionRefresh: boolean;
}

/**
 * Per-type retry policy. TRAFFIC_VERIFICATION gets zero retries deliberately: refreshing
 * the session and hammering Shopee again after its risk-control system has already flagged
 * the traffic is suspected to worsen the underlying risk/velocity score rather than help.
 * Callers should mark the session/proxy as blocked and let a human decide whether to retry
 * later, rather than looping automatically.
 */
const RETRY_POLICIES: Record<ScrapeErrorType, RetryPolicy> = {
  NETWORK_ERROR: { maxRetries: 3, needsSessionRefresh: false },
  TIMEOUT: { maxRetries: 2, needsSessionRefresh: false },
  HTTP_403: { maxRetries: 1, needsSessionRefresh: true },
  HTTP_429: { maxRetries: 1, needsSessionRefresh: true },
  TRAFFIC_VERIFICATION: { maxRetries: 0, needsSessionRefresh: false },
  INVALID_RESPONSE: { maxRetries: 1, needsSessionRefresh: true },
  SESSION_EXPIRED: { maxRetries: 1, needsSessionRefresh: true },
  PROXY_FAILURE: { maxRetries: 2, needsSessionRefresh: false },
  BROWSER_FAILURE: { maxRetries: 1, needsSessionRefresh: true },
};

interface RetryOptions {
  /** Called before retrying an error type whose policy needs a fresh session. */
  onSessionRefresh?: () => Promise<void>;
  /** Called once per PROXY_FAILURE occurrence, so the caller can rotate/quarantine it. */
  onProxyFailure?: (err: ScrapeError) => void;
}

/** Retries `fn`, applying a distinct backoff/refresh policy depending on the failure's ScrapeErrorType. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attemptsByType: Partial<Record<ScrapeErrorType, number>> = {};

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const scrapeErr = isScrapeError(err)
        ? err
        : new ScrapeError("NETWORK_ERROR", err instanceof Error ? err.message : String(err));
      const policy = RETRY_POLICIES[scrapeErr.type];
      const attempt = (attemptsByType[scrapeErr.type] ?? 0) + 1;
      attemptsByType[scrapeErr.type] = attempt;

      if (attempt > policy.maxRetries) {
        logger.error(
          { type: scrapeErr.type, attempt, maxRetries: policy.maxRetries },
          "Exhausted retries for error type, giving up"
        );
        throw scrapeErr;
      }

      logger.warn(
        { type: scrapeErr.type, attempt, maxRetries: policy.maxRetries, message: scrapeErr.message },
        "Retrying after error"
      );

      if (scrapeErr.type === "PROXY_FAILURE") {
        options.onProxyFailure?.(scrapeErr);
      }
      if (policy.needsSessionRefresh) {
        await options.onSessionRefresh?.();
      }

      await sleep(backoffMs(attempt));
    }
  }
}
