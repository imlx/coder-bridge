/**
 * TokenBucket Rate Limiter
 * 
 * 工作件代码 - 故意保留改进空间：
 * - 无持久化（重启后 token 清零）
 * - 无 burst 控制
 * - 无多桶支持
 * - refill 精度依赖 Date.now()，高频场景可能漂移
 */
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

  // TODO: waitForTokens(count, timeout) - 异步等待 token 恢复
  // TODO: toJSON() / fromJSON() - 持久化支持
  // TODO: getStats() - 返回拒绝次数、使用峰值等指标
}
