/**
 * TokenBucket Rate Limiter
 *
 * 工作件代码 - 故意保留改进空间：
 * - 无持久化（重启后 token 清零）
 * - 无 burst 控制
 * - 无多桶支持
 * - refill 精度依赖 Date.now()，高频场景可能漂移
 */
export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class RateLimiter {
  constructor({ capacity = 10, refillRate = 1 } = {}) {
    if (capacity <= 0) throw new Error('capacity must be positive');
    if (refillRate <= 0) throw new Error('refillRate must be positive');

    this.capacity = capacity;
    this.refillRate = refillRate; // tokens per second
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  tryConsume(count = 1) {
    this._refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  getAvailable() {
    this._refill();
    return Math.floor(this.tokens);
  }

  async waitForTokens(count = 1, timeout = 30000) {
    if (count > this.capacity) {
      throw new Error(`count (${count}) exceeds capacity (${this.capacity})`);
    }
    if (count <= 0) {
      throw new Error('count must be positive');
    }
    if (timeout < 0) {
      throw new Error('timeout must be non-negative');
    }

    const startTime = Date.now();

    // 快速路径：已有足够 token
    this._refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return;
    }

    return new Promise((resolve, reject) => {
      let timeoutId;
      let checkIntervalId;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (checkIntervalId) clearInterval(checkIntervalId);
      };

      // 超时处理
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new TimeoutError(`waitForTokens timed out after ${timeout}ms`));
      }, timeout);

      // 定期检查 token
      const check = () => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeout) {
          return; // let timeout handle it
        }

        this._refill();
        if (this.tokens >= count) {
          this.tokens -= count;
          cleanup();
          resolve();
        }
      };

      // 计算需要等待的时间，使用更精确的检查间隔
      const needed = count - this.tokens;
      const waitMs = Math.max(10, Math.ceil((needed / this.refillRate) * 1000));
      checkIntervalId = setInterval(check, Math.min(waitMs / 2, 50));

      // 立即检查一次
      check();
    });
  }

  // TODO: toJSON() / fromJSON() - 持久化支持
  // TODO: getStats() - 返回拒绝次数、使用峰值等指标
}
