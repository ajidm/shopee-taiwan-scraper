import { logger } from "./logger";

export class AntiBotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AntiBotError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  const jitter = Math.random() * 250;
  return base + jitter;
}

interface RetryOptions {
  /** Called once when an AntiBotError is hit, before retrying (e.g. to refresh session). */
  onAntiBotDetected?: () => Promise<void>;
  maxNetworkRetries?: number;
  maxAntiBotRetries?: number;
}

/**
 * Retries `fn`, distinguishing plain network/timeout failures (retried immediately with
 * backoff) from anti-bot signals (403/429/captcha) which trigger a session refresh first,
 * since retrying with a stale session would just fail again.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxNetworkRetries = options.maxNetworkRetries ?? 3;
  const maxAntiBotRetries = options.maxAntiBotRetries ?? 2;

  let networkAttempts = 0;
  let antiBotAttempts = 0;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AntiBotError) {
        antiBotAttempts += 1;
        if (antiBotAttempts > maxAntiBotRetries) throw err;
        logger.warn({ attempt: antiBotAttempts }, "Anti-bot signal detected, refreshing session before retry");
        await options.onAntiBotDetected?.();
        await sleep(backoffMs(antiBotAttempts));
        continue;
      }

      networkAttempts += 1;
      if (networkAttempts > maxNetworkRetries) throw err;
      logger.warn({ attempt: networkAttempts, err: (err as Error).message }, "Request failed, retrying");
      await sleep(backoffMs(networkAttempts));
    }
  }
}
