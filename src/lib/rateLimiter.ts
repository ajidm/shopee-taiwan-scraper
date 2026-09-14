const CONCURRENCY_LIMIT = Number(process.env.CONCURRENCY_LIMIT ?? 4);
const DELAY_MIN_MS = Number(process.env.REQUEST_DELAY_MIN_MS ?? 300);
const DELAY_MAX_MS = Number(process.env.REQUEST_DELAY_MAX_MS ?? 1500);

function jitterDelay(): number {
  return DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple concurrency-limiting queue with randomized jitter before each task runs,
 * so outgoing request timing doesn't look like a mechanical bot flood.
 */
class RateLimiter {
  private active = 0;
  private queue: Array<() => void> = [];

  private acquire(): Promise<void> {
    if (this.active < CONCURRENCY_LIMIT) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) {
      this.active += 1;
      next();
    }
  }

  async schedule<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await sleep(jitterDelay());
      return await task();
    } finally {
      this.release();
    }
  }
}

export const rateLimiter = new RateLimiter();
