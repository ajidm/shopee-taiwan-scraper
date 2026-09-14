import { ScrapeError } from "../lib/errors";

/**
 * Technique #12 (Teknik Anti-Deteksi): per-key circuit breaker. Once a key (e.g. a
 * storeId+dealId session) hits Shopee's traffic-verification wall, refuse to retry it
 * until a cooldown passes — retrying instantly just adds another flagged navigation on
 * top of the one that already got blocked — aggressive refresh+retry loops are suspected
 * to worsen a velocity-based risk score rather than help.
 */
export class CircuitBreaker {
  private blockedUntil = new Map<string, number>();

  constructor(private readonly cooldownMs: number) {}

  assertNotBlocked(key: string): void {
    const until = this.blockedUntil.get(key);
    if (until && Date.now() < until) {
      const remainingSec = Math.ceil((until - Date.now()) / 1000);
      throw new ScrapeError(
        "TRAFFIC_VERIFICATION",
        `Key ${key} is in cooldown after traffic verification wall (${remainingSec}s remaining)`
      );
    }
  }

  trip(key: string): void {
    this.blockedUntil.set(key, Date.now() + this.cooldownMs);
  }

  clear(key: string): void {
    this.blockedUntil.delete(key);
  }
}
