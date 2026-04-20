/**
 * Token bucket rate limiter for Google Chat API calls.
 * Shared across all workers in the same process.
 */
export class RateLimiter {
  constructor(tokensPerSecond = 400) {
    this.tokensPerSecond = tokensPerSecond;
    this.tokens = tokensPerSecond;
    this.lastRefill = Date.now();
  }

  async acquire(count = 1) {
    while (true) {
      this._refill();
      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }
      // Wait until enough tokens are available
      const wait = Math.ceil((count - this.tokens) / this.tokensPerSecond * 1000);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.tokensPerSecond, this.tokens + elapsed * this.tokensPerSecond);
    this.lastRefill = now;
  }
}

// Singleton — shared across all workers in same process
export const globalRateLimiter = new RateLimiter(
  parseInt(process.env.S2G_GLOBAL_MSG_PER_SEC || '400', 10)
);
